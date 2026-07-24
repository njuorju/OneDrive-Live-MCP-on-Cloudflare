import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import patchedDefault, {
  AuthState,
  OneDriveMCP,
  PaidConnectorWorkflow,
  PaidCoordinator,
} from "./index-hotfix";
import { registerStructuredPreparationTools } from "./structured-preparation";
import { createIntegratedStateStorage } from "./version20-hotfix";

const prototype = OneDriveMCP.prototype as any;
if (!prototype.__finalEngineeringCloseoutApplied) {
  const previousInit = prototype.init as () => Promise<void>;
  prototype.init = async function finalEngineeringCloseoutInit(this: any): Promise<void> {
    await previousInit.call(this);
    const userId = String(this.props?.userId ?? "");
    if (!userId) throw new Error("No authorized Microsoft user is attached.");
    const supplement = new McpServer({
      name: "Nikolay OneDrive Live final engineering closeout",
      version: "0.6.0",
    });
    registerStructuredPreparationTools(supplement, () => ({
      env: this.env,
      userId,
      storage: createIntegratedStateStorage(this.env, userId),
    }));
    const actual = this.server as any;
    const additions = supplement as any;
    for (const [name, tool] of Object.entries(additions._registeredTools ?? {})) {
      actual._registeredTools[name] = tool;
    }
  };
  Object.defineProperty(prototype, "__finalEngineeringCloseoutApplied", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export { AuthState, OneDriveMCP, PaidCoordinator, PaidConnectorWorkflow };
export default patchedDefault;
