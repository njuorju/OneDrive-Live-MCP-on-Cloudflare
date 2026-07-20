import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import originalDefault, { AuthState, OneDriveMCP } from "./index";
import {
  registerIntegratedToolsWithQuietPdfJsHotfix,
} from "./pdfjs-final-registration";
import {
  continueSourceSnapshotJob,
  registerSourceSnapshotRepairTools,
} from "./source-snapshot-repair";
import { createIntegratedStateStorage } from "./version20-hotfix";

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
    await continueSourceSnapshotJob(
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
      name: "Nikolay OneDrive Live integrated hotfix",
      version: "0.4.3",
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

export { AuthState, OneDriveMCP };
export default originalDefault;
