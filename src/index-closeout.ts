import patchedDefault, {
  AuthState,
  OneDriveMCP,
  PaidConnectorWorkflow,
  PaidCoordinator,
} from "./index-hotfix";
import { registerStructuredPreparationTools } from "./structured-preparation";
import { registerComposedPreparedPlanTool } from "./composed-prepared-plan";
import { registerVisualPhase2Tools } from "./visual-phase2";
import { registerAccessVerificationValidator } from "./access-verification-validator";
import { createIntegratedStateStorage } from "./version20-hotfix";

const prototype = OneDriveMCP.prototype as any;
if (!prototype.__finalEngineeringCloseoutApplied) {
  const previousInit = prototype.init as () => Promise<void>;
  prototype.init = async function finalEngineeringCloseoutInit(this: any): Promise<void> {
    await previousInit.call(this);
    const userId = String(this.props?.userId ?? "");
    if (!userId) throw new Error("No authorized Microsoft user is attached.");
    const actual = this.server as any;
    const contextFactory = () => ({
      env: this.env,
      userId,
      storage: createIntegratedStateStorage(this.env, userId),
    });
    registerStructuredPreparationTools(actual, contextFactory);
    registerComposedPreparedPlanTool(actual, contextFactory);
    registerVisualPhase2Tools(actual, contextFactory);
    registerAccessVerificationValidator(actual, contextFactory);
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
