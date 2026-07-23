import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import originalDefault, { AuthState, OneDriveMCP } from "./index";
import {
  registerIntegratedToolsWithQuietPdfJsHotfix,
} from "./pdfjs-final-registration";
import { registerSourceSnapshotRepairTools } from "./source-snapshot-repair";
import { createIntegratedStateStorage } from "./version20-hotfix";
import { registerIntegrityResumeRepairTools } from "./integrity-resume-repair";
import { registerDownstreamRenameReconciliationTool } from "./integrity-downstream-reconcile";
import { registerBlockedMoveReconciliationTool } from "./integrity-blocked-move-reconcile";
import { continueSnapshotWithLease, registerIntegrityLeaseTools } from "./integrity-lease-tools";
import type { ScheduleSnapshot } from "./snapshot-model";
import {
  DEFAULT_SOURCE_INTEGRITY_PLAN_ID,
  SOURCE_INTEGRITY_OWNER_ID,
  runScheduledIntegrityContinuation,
} from "./scheduled-integrity";
import { PaidCoordinator } from "./paid-coordinator";
import {
  PaidConnectorWorkflow,
  handlePaidRenderRoute,
  processPaidQueueBatch,
} from "./paid-jobs";
import { registerPaidArchitectureTools } from "./paid-tools";
import type { PaidJobMessage } from "./paid-core";

const prototype = OneDriveMCP.prototype as any;
if (!prototype.__version20HotfixApplied) {
  prototype.__continueSourceSnapshot = async function continueSourceSnapshot(
    this: any,
    payload: { jobId?: string; userId?: string },
  ): Promise<void> {
    const jobId = String(payload?.jobId ?? "");
    const userId = String(payload?.userId ?? "");
    if (!jobId || !userId) throw new Error("The scheduled snapshot payload is incomplete.");
    const schedule = async (nextJobId: string, nextUserId: string, delaySeconds = 1): Promise<void> => {
      await this.schedule(
        Math.max(1, Math.ceil(delaySeconds)),
        "__continueSourceSnapshot",
        { jobId: nextJobId, userId: nextUserId },
      );
    };
    await continueSnapshotWithLease(
      {
        env: this.env,
        userId,
        storage: createIntegratedStateStorage(this.env, userId),
      },
      schedule,
      jobId,
    );
  };

  const originalInit = prototype.init as () => Promise<void>;
  prototype.init = async function version20HotfixedInit(this: any): Promise<void> {
    await originalInit.call(this);

    const userId = String(this.props?.userId ?? "");
    if (!userId) throw new Error("No authorized Microsoft user is attached.");

    const replacementServer = new McpServer({
      name: "Nikolay OneDrive Live paid architecture",
      version: "0.5.0",
    });
    const contextFactory = () => ({
      env: this.env,
      userId,
      storage: createIntegratedStateStorage(this.env, userId),
    });
    const schedule = async (jobId: string, scheduledUserId: string, delaySeconds = 1): Promise<void> => {
      await this.schedule(
        Math.max(1, Math.ceil(delaySeconds)),
        "__continueSourceSnapshot",
        { jobId, userId: scheduledUserId },
      );
    };

    registerIntegratedToolsWithQuietPdfJsHotfix(replacementServer, contextFactory);
    registerSourceSnapshotRepairTools(replacementServer, contextFactory, schedule);
    registerIntegrityResumeRepairTools(replacementServer, contextFactory, schedule);
    registerDownstreamRenameReconciliationTool(replacementServer, contextFactory);
    registerBlockedMoveReconciliationTool(replacementServer, contextFactory);
    registerIntegrityLeaseTools(replacementServer, contextFactory, schedule);

    const repairedSnapshotHandler = (replacementServer as any)._registeredTools?.create_source_snapshot?.handler;
    registerPaidArchitectureTools(replacementServer, contextFactory);
    if (repairedSnapshotHandler && (replacementServer as any)._registeredTools?.create_source_snapshot) {
      (replacementServer as any)._registeredTools.create_source_snapshot.handler = repairedSnapshotHandler;
    }

    const actual = this.server as any;
    const replacement = replacementServer as any;
    for (const [name, tool] of Object.entries(replacement._registeredTools ?? {})) {
      actual._registeredTools[name] = tool;
    }
    for (const [uri, resource] of Object.entries(replacement._registeredResources ?? {})) {
      actual._registeredResources[uri] = resource;
    }
    for (const [name, template] of Object.entries(replacement._registeredResourceTemplates ?? {})) {
      actual._registeredResourceTemplates[name] = template;
    }
  };
  Object.defineProperty(prototype, "__version20HotfixApplied", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

type SchedulerEnv = Env & {
  SOURCE_INTEGRITY_PLAN_ID?: string;
  SCHEDULE_ADMIN_TOKEN?: string;
};

function timestampedCorrelationId(): string {
  return `uca-source-hourly-${new Date().toISOString().replace(/[^0-9TZ]/g, "")}`.slice(0, 200);
}

async function invokeSourceIntegritySchedule(env: SchedulerEnv, ctx: ExecutionContext): Promise<Record<string, unknown>> {
  const userId = String(env.OWNER_MICROSOFT_ID ?? "");
  if (!userId) throw new Error("OWNER_MICROSOFT_ID is not configured.");
  const planId = String(env.SOURCE_INTEGRITY_PLAN_ID ?? DEFAULT_SOURCE_INTEGRITY_PLAN_ID);
  const invocationId = crypto.randomUUID();
  const correlationId = timestampedCorrelationId();
  const schedule: ScheduleSnapshot = async (jobId, scheduledUserId, delaySeconds = 1) => {
    console.log(JSON.stringify({
      component: "source_integrity_scheduler",
      event: "continuation_deferred_to_next_cron",
      jobId,
      scheduledUserId,
      delaySeconds,
      invocationId,
      correlationId,
    }));
  };
  return runScheduledIntegrityContinuation(
    {
      env,
      userId,
      storage: createIntegratedStateStorage(env, userId),
      waitUntil: (promise) => ctx.waitUntil(promise),
    },
    schedule,
    {
      planId,
      ownerId: SOURCE_INTEGRITY_OWNER_ID,
      invocationId,
      correlationId,
    },
  );
}

const provider = originalDefault as any;
const worker: ExportedHandler<SchedulerEnv> = {
  async fetch(request, env, ctx): Promise<Response> {
    const paidRender = await handlePaidRenderRoute(request, env);
    if (paidRender) return paidRender;

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/scheduled-integrity-once") {
      const expected = String(env.SCHEDULE_ADMIN_TOKEN ?? "");
      const supplied = String(request.headers.get("x-schedule-admin-token") ?? "");
      if (!expected || supplied !== expected) return new Response("Not found", { status: 404 });
      try {
        return Response.json(await invokeSourceIntegritySchedule(env, ctx));
      } catch (error) {
        console.error(JSON.stringify({ component: "source_integrity_scheduler", event: "manual_invoke_failed", message: error instanceof Error ? error.message : String(error) }));
        return Response.json({ ok: false, error: "scheduled_integrity_failed" }, { status: 500 });
      }
    }
    return provider.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env): Promise<void> {
    const paidEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "MAX_FILE_MB") return String(target.PAID_VISUAL_PARSE_MB ?? target.MAX_FILE_MB);
        return Reflect.get(target, property, receiver);
      },
    });
    await processPaidQueueBatch(batch as MessageBatch<PaidJobMessage>, paidEnv);
  },

  scheduled(_controller, env, ctx): void {
    ctx.waitUntil(
      invokeSourceIntegritySchedule(env, ctx)
        .then((result) => console.log(JSON.stringify({ component: "source_integrity_scheduler", event: "completed", result })))
        .catch((error) => console.error(JSON.stringify({ component: "source_integrity_scheduler", event: "failed", message: error instanceof Error ? error.message : String(error) }))),
    );
  },
};

export { AuthState, OneDriveMCP, PaidCoordinator, PaidConnectorWorkflow };
export default worker;
