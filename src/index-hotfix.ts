import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import originalDefault, { AuthState, OneDriveMCP } from "./index";
import {
  createIntegratedStateStorage,
  registerIntegratedToolsWithVersion20Hotfix,
} from "./version20-hotfix";

const prototype = OneDriveMCP.prototype as any;
if (!prototype.__version20HotfixApplied) {
  const originalInit = prototype.init as () => Promise<void>;
  prototype.init = async function version20HotfixedInit(this: any): Promise<void> {
    await originalInit.call(this);

    const userId = String(this.props?.userId ?? "");
    if (!userId) throw new Error("No authorized Microsoft user is attached.");

    const replacementServer = new McpServer({
      name: "Nikolay OneDrive Live integrated hotfix",
      version: "0.4.1",
    });
    registerIntegratedToolsWithVersion20Hotfix(replacementServer, () => ({
      env: this.env,
      userId,
      storage: createIntegratedStateStorage(this.env, userId),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    }));

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
