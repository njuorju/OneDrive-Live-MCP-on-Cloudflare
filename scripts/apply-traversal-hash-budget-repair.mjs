import { readFile, writeFile } from "node:fs/promises";

async function patchGraphCore() {
  const path = "src/graph-core.ts";
  let source = await readFile(path, "utf8");
  if (source.includes("maxBytes: number,\n  init: RequestInit = {},")) return;
  const before = `export async function graphFetchBytes(\n  env: Env,\n  userId: string,\n  pathOrUrl: string,\n  maxBytes: number,\n): Promise<ArrayBuffer> {\n  const response = await graphResponse(env, userId, pathOrUrl, { redirect: \"follow\" });`;
  const after = `export async function graphFetchBytes(\n  env: Env,\n  userId: string,\n  pathOrUrl: string,\n  maxBytes: number,\n  init: RequestInit = {},\n): Promise<ArrayBuffer> {\n  const response = await graphResponse(env, userId, pathOrUrl, { ...init, redirect: \"follow\" });`;
  if (!source.includes(before)) throw new Error("graphFetchBytes marker not found");
  source = source.replace(before, after);
  await writeFile(path, source, "utf8");
}

async function patchIntegratedTools() {
  const path = "src/integrated-tools.ts";
  let source = await readFile(path, "utf8");
  if (!source.includes("export async function shaForTraversedItem(")) {
    const marker = `async function shaForItem(context: IntegratedContext, itemId: string): Promise<{ sha256: string; byteSize: number; eTag: string | null; verified: VerifiedItem; buffer: ArrayBuffer }> {\n  const { verified, buffer } = await downloadVerifiedItem(context.env, context.userId, itemId, INTEGRATED_LIMITS.fileBytesMax);\n  return { sha256: await sha256Bytes(buffer), byteSize: buffer.byteLength, eTag: verified.item.eTag ?? null, verified, buffer };\n}\n`;
    const replacement = `${marker}\nexport async function shaForTraversedItem(\n  context: IntegratedContext,\n  verified: VerifiedItem,\n): Promise<{ sha256: string; byteSize: number; eTag: string | null; verified: VerifiedItem; buffer: ArrayBuffer }> {\n  const item = verified.item;\n  const rootDriveId = verified.root.parentReference?.driveId;\n  if (item.folder) throw new ConnectorError(\"folder_not_file\", \"The requested item is a folder, not a file.\");\n  if (item.remoteItem || item.deleted || !item.parentReference?.driveId || !rootDriveId || item.parentReference.driveId !== verified.driveId || rootDriveId !== verified.driveId) {\n    throw new ConnectorError(\"outside_root\", \"The traversed item is no longer proven inside the configured root.\");\n  }\n  const limit = INTEGRATED_LIMITS.fileBytesMax;\n  if ((item.size ?? 0) > limit) throw new ConnectorError(\"file_too_large\", \"The file exceeds the configured size limit.\");\n  const headers = item.eTag ? { \"If-Match\": item.eTag } : undefined;\n  const buffer = await graphFetchBytes(\n    context.env,\n    context.userId,\n    \`/me/drive/items/\${encodeURIComponent(item.id)}/content\`,\n    limit,\n    headers ? { headers } : {},\n  );\n  return { sha256: await sha256Bytes(buffer), byteSize: buffer.byteLength, eTag: item.eTag ?? null, verified, buffer };\n}\n`;
    if (!source.includes(marker)) throw new Error("shaForItem marker not found");
    source = source.replace(marker, replacement);
  }

  if (!source.includes("type EnumeratedLiveResult =")) {
    const startMarker = `async function enumerateLive(context: IntegratedContext, scopePath: string, maximumItems: number = INTEGRATED_LIMITS.snapshotItemsMax, recursive = true): Promise<SnapshotRecord[]> {`;
    const endMarker = `\n}\n\nexport function snapshotRecordSizeChanged`;
    const start = source.indexOf(startMarker);
    const endStart = source.indexOf(endMarker, start);
    if (start < 0 || endStart < 0) throw new Error("enumerateLive markers not found");
    const end = endStart + 2;
    const replacement = `type EnumeratedLiveResult = {\n  records: SnapshotRecord[];\n  verifiedById: Map<string, VerifiedItem>;\n};\n\nasync function enumerateLiveVerified(\n  context: IntegratedContext,\n  scopePath: string,\n  maximumItems: number = INTEGRATED_LIMITS.snapshotItemsMax,\n  recursive = true,\n): Promise<EnumeratedLiveResult> {\n  const root = await resolveRelativeFolder(context.env, context.userId, scopePath);\n  const queue: VerifiedItem[] = [root];\n  const records: SnapshotRecord[] = [];\n  const verifiedById = new Map<string, VerifiedItem>();\n  while (queue.length > 0 && records.length < maximumItems) {\n    const folder = queue.shift();\n    if (!folder) break;\n    let nextUrl: string | undefined;\n    do {\n      const page = await listVerifiedChildren(context.env, context.userId, folder, 200, nextUrl);\n      nextUrl = page.nextUrl;\n      for (const child of page.items) {\n        const compact = compactVerifiedItem(child);\n        records.push({\n          ...compact,\n          snapshotIndex: records.length,\n          parentItemId: child.item.parentReference?.id ?? null,\n          createdDate: null,\n          sha256: null,\n          normalizedTextSha256: null,\n          extractedCharacterCount: null,\n          extractionStatus: null,\n          representationStatus: null,\n          documentMetadata: null,\n          error: null,\n        });\n        verifiedById.set(child.item.id, child);\n        if (child.item.folder && recursive) queue.push(child);\n        if (records.length >= maximumItems) break;\n      }\n    } while (nextUrl && records.length < maximumItems);\n  }\n  return { records, verifiedById };\n}\n\nasync function enumerateLive(context: IntegratedContext, scopePath: string, maximumItems: number = INTEGRATED_LIMITS.snapshotItemsMax, recursive = true): Promise<SnapshotRecord[]> {\n  return (await enumerateLiveVerified(context, scopePath, maximumItems, recursive)).records;\n}`;
    source = source.slice(0, start) + replacement + source.slice(end);
  }

  const compareBefore = `  const snapshot = await listSnapshotRecords(context, snapshotId);\n  const live = await enumerateLive(context, meta.scopePath, Math.max(meta.totalRecords + 1_000, INTEGRATED_LIMITS.snapshotItemsDefault));\n  const snapshotById = new Map(snapshot.map((record) => [record.itemId, record]));`;
  const compareAfter = `  const snapshot = await listSnapshotRecords(context, snapshotId);\n  const enumerated = await enumerateLiveVerified(context, meta.scopePath, Math.max(meta.totalRecords + 1_000, INTEGRATED_LIMITS.snapshotItemsDefault));\n  const live = enumerated.records;\n  const snapshotById = new Map(snapshot.map((record) => [record.itemId, record]));`;
  if (source.includes(compareBefore)) source = source.replace(compareBefore, compareAfter);
  else if (!source.includes("const enumerated = await enumerateLiveVerified(context, meta.scopePath")) throw new Error("compare enumeration marker not found");

  const hashBefore = `    if (before.sha256 && before.eTag !== after.eTag && after.type === \"file\") {\n      const currentHash = (await shaForItem(context, after.itemId)).sha256;\n      if (currentHash !== before.sha256) changedSha256.push({ itemId: before.itemId, path: after.relativePath, before: before.sha256, after: currentHash });\n    }`;
  const hashAfter = `    if (before.sha256 && before.eTag !== after.eTag && after.type === \"file\") {\n      const traversed = enumerated.verifiedById.get(after.itemId);\n      if (!traversed) throw new ConnectorError(\"live_item_unverified\", \"The changed live item was not retained from the verified traversal.\");\n      const currentHash = (await shaForTraversedItem(context, traversed)).sha256;\n      if (currentHash !== before.sha256) changedSha256.push({ itemId: before.itemId, path: after.relativePath, before: before.sha256, after: currentHash });\n    }`;
  if (source.includes(hashBefore)) source = source.replace(hashBefore, hashAfter);
  else if (!source.includes("const traversed = enumerated.verifiedById.get(after.itemId)")) throw new Error("compare hash marker not found");

  await writeFile(path, source, "utf8");
}

async function patchTests() {
  const path = "test/integrity-free-plan.test.ts";
  let tests = await readFile(path, "utf8");
  tests = tests.replace(
    'import { auditDuplicateHashGroups, reconstructAuditLiveRecords } from "../src/integrated-tools.js";',
    'import { auditDuplicateHashGroups, reconstructAuditLiveRecords, shaForTraversedItem } from "../src/integrated-tools.js";',
  );
  if (!tests.includes("changed-file audit hashing reuses traversal proof")) {
    tests += `\n\ntest("changed-file audit hashing reuses traversal proof and stays below 50", async () => {\n  const root = item("root", "Работа", "drive-root", '\"root\",1', true);\n  const key = "test-cookie-key-at-least-32-bytes-long";\n  const sealed = await sealJson(key, { accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000, scope: "Files.ReadWrite" });\n  const env = {\n    COOKIE_ENCRYPTION_KEY: key,\n    AUTH_STATE: {\n      idFromName: () => ({}) as DurableObjectId,\n      get: () => ({ fetch: async () => Response.json({ ok: true, found: true, expired: false, value: sealed }) }) as unknown as DurableObjectStub,\n    } as DurableObjectNamespace,\n  } as Env;\n  let externalFetches = 0;\n  const originalFetch = globalThis.fetch;\n  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {\n    externalFetches += 1;\n    assert.match(String(url), /\\/content$/);\n    assert.equal(new Headers(init?.headers).get("If-Match"), '\"file\",2');\n    return new Response("0123456789", { status: 200, headers: { "content-length": "10" } });\n  }) as typeof fetch;\n  try {\n    for (let index = 0; index < 3; index += 1) {\n      const live = verified(item(\`file-\${index}\`, \`file-\${index}.txt\`, "parent", '\"file\",2'), root, \`scope/file-\${index}.txt\`, [\`file-\${index}\`, "parent", "root"]);\n      const result = await shaForTraversedItem({ env, userId: "user", storage: {} as any }, live);\n      assert.equal(result.byteSize, 10);\n      assert.equal(result.sha256.length, 64);\n    }\n    assert.equal(externalFetches, 3);\n    assert.ok(externalFetches < WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT);\n  } finally {\n    globalThis.fetch = originalFetch;\n  }\n});\n`;
  }
  await writeFile(path, tests, "utf8");
}

await patchGraphCore();
await patchIntegratedTools();
await patchTests();
console.log("TRAVERSAL_HASH_BUDGET_REPAIR_APPLIED");
