import { ConnectorError } from "./errors";
import { resolveRelativeFolder } from "./graph-core";
import { INTEGRATED_LIMITS } from "./integrated-core";
import type { HotfixContext } from "./version20-hotfix";
import { reliableGraphJson } from "./snapshot-graph";
import { enrichRecord } from "./snapshot-enrich";
import {
  JOB_RETENTION_SECONDS,
  JOB_RETRY_BUDGET,
  SNAPSHOT_RETENTION_SECONDS,
  STEP_WALL_BUDGET_MS,
  allowed,
  checkpointKey,
  cleanupExpired,
  expiryIso,
  finishPending,
  getCheckpoint,
  getJob,
  nowIso,
  persistState,
  putJob,
  seenKey,
  snapshotMetaKey,
  strictPath,
  type JobRecord,
  type ListedItem,
  type ScheduleSnapshot,
  type SnapshotCheckpoint,
  type SnapshotInput,
  type SnapshotMeta,
} from "./snapshot-model";

export async function continueSourceSnapshotJob(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<void> {
  const storage = context.storage;
  const job = await getJob(storage, jobId);
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return;
  const snapshotId = String(job.resultReferences.snapshotId ?? "");
  const checkpoint = await getCheckpoint(storage, snapshotId);
  const meta = await storage.get<SnapshotMeta>(snapshotMetaKey(snapshotId));
  if (!meta) throw new ConnectorError("snapshot_not_found", "The snapshot does not exist or has expired.");
  job.status = "running";
  job.progress = Math.max(1, job.progress);
  job.currentStage = job.currentStage === "queued" ? "enumerating_page_1" : job.currentStage;
  await persistState(storage, checkpoint, meta, job);
  const started = Date.now();
  const configured = Number((context.env as unknown as Record<string, unknown>).SNAPSHOT_STEP_ITEMS ?? 20);
  const stepItems = Math.min(Math.max(Number.isFinite(configured) ? configured : 20, 1), 50);
  let processed = 0;
  try {
    await finishPending(storage, checkpoint, meta, job);
    while (checkpoint.queue.length > 0 && checkpoint.recordIndex < checkpoint.input.maximumItems && processed < stepItems && Date.now() - started < STEP_WALL_BUDGET_MS) {
      if (!checkpoint.activePage) {
        const folder = checkpoint.queue[0];
        const path = folder.nextUrl ?? `/me/drive/items/${encodeURIComponent(folder.itemId)}/children?$top=200&$select=${encodeURIComponent("id,name,size,file,folder,package,parentReference,createdDateTime,lastModifiedDateTime,eTag,cTag,remoteItem,deleted")}`;
        const page = await reliableGraphJson<{ value?: ListedItem[]; "@odata.nextLink"?: string }>(context.env, context.userId, path, {
          operation: "source_snapshot.enumerate",
          endpointCategory: "children_page",
          pageNumber: checkpoint.pageNumber + 1,
          enumeratedCount: checkpoint.recordIndex,
          pathContext: folder.relativePath,
        });
        checkpoint.pageNumber += 1;
        checkpoint.activePage = {
          folder: { ...folder },
          items: (page.value ?? []).filter((item) => !item.deleted && !item.remoteItem),
          offset: 0,
          nextUrl: page["@odata.nextLink"],
          pageNumber: checkpoint.pageNumber,
        };
        job.currentStage = `enumerating_page_${checkpoint.pageNumber}_items_${checkpoint.recordIndex}`;
        job.progress = Math.min(95, Math.max(1, 1 + checkpoint.pageNumber + Math.floor(checkpoint.recordIndex / 5)));
        await persistState(storage, checkpoint, meta, job);
      }
      const active = checkpoint.activePage;
      if (!active) continue;
      if (active.offset >= active.items.length) {
        if (active.nextUrl) checkpoint.queue[0] = { ...checkpoint.queue[0], nextUrl: active.nextUrl };
        else checkpoint.queue.shift();
        checkpoint.activePage = undefined;
        await persistState(storage, checkpoint, meta, job);
        continue;
      }
      const item = active.items[active.offset];
      const relativePath = active.folder.relativePath ? `${active.folder.relativePath}/${item.name}` : item.name;
      const seen = await storage.get<boolean>(seenKey(snapshotId, item.id));
      if (seen) {
        active.offset += 1;
        await persistState(storage, checkpoint, meta, job);
        continue;
      }
      const enqueue = item.folder && checkpoint.input.recursive && active.folder.depth < checkpoint.input.maximumDepth
        ? { itemId: item.id, relativePath, depth: active.folder.depth + 1 }
        : undefined;
      if (!allowed(item, checkpoint.input)) {
        if (enqueue) checkpoint.queue.push(enqueue);
        active.offset += 1;
        processed += 1;
        await persistState(storage, checkpoint, meta, job);
        continue;
      }
      const record = await enrichRecord(context, item, relativePath, checkpoint.recordIndex, checkpoint.input, {
        operation: "source_snapshot.capture_item",
        endpointCategory: "item",
        pageNumber: checkpoint.pageNumber,
        enumeratedCount: checkpoint.recordIndex,
        pathContext: relativePath,
      });
      checkpoint.pending = { itemId: item.id, recordIndex: checkpoint.recordIndex, record, isFile: !item.folder, enqueue };
      await persistState(storage, checkpoint, meta, job);
      await finishPending(storage, checkpoint, meta, job);
      processed += 1;
    }
    if (checkpoint.queue.length === 0) {
      const root = await reliableGraphJson<ListedItem>(context.env, context.userId, `/me/drive/items/${encodeURIComponent(meta.rootItemId)}?$select=id,eTag,cTag`, {
        operation: "source_snapshot.finalize",
        endpointCategory: "root_metadata",
        pageNumber: checkpoint.pageNumber,
        enumeratedCount: checkpoint.recordIndex,
        pathContext: meta.scopePath,
      });
      if ((meta.rootETag && root.eTag !== meta.rootETag) || (meta.rootCTag && root.cTag !== meta.rootCTag)) {
        throw new ConnectorError("snapshot_source_changed", "The source subtree changed while the snapshot was being captured.");
      }
      meta.totalFiles = checkpoint.totalFiles;
      meta.totalFolders = checkpoint.totalFolders;
      meta.totalRecords = checkpoint.recordIndex;
      meta.complete = true;
      job.status = "completed";
      job.progress = 100;
      job.currentStage = "completed";
      job.error = null;
      job.resultReferences = {
        snapshotId,
        scopePath: meta.scopePath,
        totalFiles: meta.totalFiles,
        totalFolders: meta.totalFolders,
        complete: true,
        pagesEnumerated: checkpoint.pageNumber,
      };
      await storage.put(snapshotMetaKey(snapshotId), meta);
      await putJob(storage, job);
      await storage.delete(checkpointKey(snapshotId));
      return;
    }
    if (checkpoint.recordIndex >= checkpoint.input.maximumItems) {
      meta.totalFiles = checkpoint.totalFiles;
      meta.totalFolders = checkpoint.totalFolders;
      meta.totalRecords = checkpoint.recordIndex;
      meta.complete = false;
      meta.errors.push({ code: "maximum_items_reached", message: "The snapshot reached maximumItems before enumeration completed." });
      job.status = "completed";
      job.progress = 100;
      job.currentStage = "completed";
      job.resultReferences = {
        snapshotId,
        scopePath: meta.scopePath,
        totalFiles: meta.totalFiles,
        totalFolders: meta.totalFolders,
        complete: false,
        pagesEnumerated: checkpoint.pageNumber,
      };
      await storage.put(snapshotMetaKey(snapshotId), meta);
      await putJob(storage, job);
      await storage.delete(checkpointKey(snapshotId));
      return;
    }
    checkpoint.retryCount = 0;
    await persistState(storage, checkpoint, meta, job);
    await schedule(jobId, checkpoint.userId, 1);
  } catch (error) {
    const safe = error instanceof ConnectorError
      ? error
      : new ConnectorError("snapshot_runner_failed", "The resumable snapshot runner failed.", { retryable: false });
    if (safe.retryable && checkpoint.retryCount < JOB_RETRY_BUDGET) {
      checkpoint.retryCount += 1;
      job.status = "running";
      job.currentStage = `retrying_${safe.code}_attempt_${checkpoint.retryCount}`;
      job.error = {
        code: safe.code,
        message: safe.message,
        retryable: true,
        status: safe.status,
        correlationId: safe.correlationId,
      };
      await persistState(storage, checkpoint, meta, job);
      await schedule(jobId, checkpoint.userId, Math.min(30, 2 ** Math.min(checkpoint.retryCount, 5)));
      return;
    }
    meta.totalFiles = checkpoint.totalFiles;
    meta.totalFolders = checkpoint.totalFolders;
    meta.totalRecords = checkpoint.recordIndex;
    meta.complete = false;
    meta.errors.push({ code: safe.code, message: safe.message });
    job.status = "failed";
    job.currentStage = "failed";
    job.error = {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      status: safe.status,
      correlationId: safe.correlationId,
    };
    await storage.put(snapshotMetaKey(snapshotId), meta);
    await putJob(storage, job);
  }
}

export async function createSourceSnapshot(context: HotfixContext, schedule: ScheduleSnapshot, raw: SnapshotInput): Promise<Record<string, unknown>> {
  const input: SnapshotInput = {
    ...raw,
    scopePath: strictPath(String(raw.scopePath ?? "")),
    maximumItems: Math.min(Math.max(Number(raw.maximumItems || INTEGRATED_LIMITS.snapshotItemsDefault), 1), INTEGRATED_LIMITS.snapshotItemsMax),
    maximumDepth: Math.min(Math.max(Number(raw.maximumDepth || INTEGRATED_LIMITS.recursionDepthDefault), 0), INTEGRATED_LIMITS.recursionDepthMax),
  };
  const root = await resolveRelativeFolder(context.env, context.userId, input.scopePath);
  const snapshotId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const createdAt = nowIso();
  const meta: SnapshotMeta = {
    snapshotId,
    scopePath: input.scopePath,
    createdAt,
    expiresAt: expiryIso(SNAPSHOT_RETENTION_SECONDS),
    rootItemId: root.item.id,
    rootETag: root.item.eTag ?? null,
    rootCTag: root.item.cTag ?? null,
    totalFiles: 0,
    totalFolders: 0,
    totalRecords: 0,
    complete: false,
    options: {
      ...input,
      consistency: "logical capture over Graph pagination; root cTag/eTag and per-file eTags are checked before completion",
    },
    errors: [],
    jobId,
  };
  const job: JobRecord = {
    jobId,
    type: "source_snapshot",
    status: "queued",
    progress: 0,
    currentStage: "queued",
    createdAt,
    updatedAt: createdAt,
    expiresAt: expiryIso(JOB_RETENTION_SECONDS),
    resultReferences: { snapshotId },
    error: null,
  };
  const checkpoint: SnapshotCheckpoint = {
    version: 1,
    snapshotId,
    jobId,
    userId: context.userId,
    input,
    queue: [{ itemId: root.item.id, relativePath: input.scopePath, depth: 0 }],
    recordIndex: 0,
    totalFiles: 0,
    totalFolders: 0,
    pageNumber: 0,
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
  };
  await context.storage.put(snapshotMetaKey(snapshotId), meta);
  await context.storage.put(checkpointKey(snapshotId), checkpoint);
  await putJob(context.storage, job);
  await schedule(jobId, context.userId, 1);
  return {
    snapshotId,
    scopePath: input.scopePath,
    createdAt,
    totalFiles: 0,
    totalFolders: 0,
    jobId,
    asynchronous: true,
    resumable: true,
  };
}

export async function getJobStatus(context: HotfixContext, schedule: ScheduleSnapshot, jobId: string): Promise<JobRecord> {
  const job = await getJob(context.storage, jobId);
  await cleanupExpired(context.storage, job);
  if ((job.status === "queued" || job.status === "running") && Date.now() - Date.parse(job.updatedAt) > 30_000) {
    const snapshotId = String(job.resultReferences.snapshotId ?? "");
    const checkpoint = await context.storage.get<SnapshotCheckpoint>(checkpointKey(snapshotId));
    if (checkpoint && (!checkpoint.lastResumeRequestedAt || Date.now() - Date.parse(checkpoint.lastResumeRequestedAt) > 30_000)) {
      checkpoint.lastResumeRequestedAt = nowIso();
      await context.storage.put(checkpointKey(snapshotId), checkpoint);
      await schedule(jobId, context.userId, 1);
      job.currentStage = `resuming_${job.currentStage}`;
      await putJob(context.storage, job);
    }
  }
  return job;
}

export { cleanupExpired };
export const snapshotRunnerTestHooks = { cleanupExpired, getJobStatus };
