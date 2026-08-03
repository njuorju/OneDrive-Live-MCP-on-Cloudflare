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
import { registerVisualCatalogueCompilerTools, VisualCatalogueWorkflow as BaseVisualCatalogueWorkflow } from "./visual-catalogue-tools";
import { createIntegratedStateStorage } from "./version20-hotfix";
import {
  isCapabilityWorkflowPayload,
  registerODLReq021Tools,
  runVisualClassifierCapabilityWorkflow,
} from "./visual-classifier-capability";
import { registerODLReq021VisibleBridge } from "./visual-capability-visible-bridge";
import { isOpenCodeGoCapabilityWorkflowPayload, runOpenCodeGoCapabilityWorkflow } from "./visual-classifier-capability-go";
import {
  isOpenCodeGoVisionDiagnosticWorkflowPayload,
  runOpenCodeGoVisionDiagnosticWorkflow,
} from "./visual-classifier-capability-go-diagnostic";

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
    registerVisualCatalogueCompilerTools(actual, contextFactory);
    registerODLReq021Tools(actual, contextFactory);
    registerODLReq021VisibleBridge(actual);
  };
  Object.defineProperty(prototype, "__finalEngineeringCloseoutApplied", {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export class VisualCatalogueWorkflow extends BaseVisualCatalogueWorkflow {
  async run(event: any, step: any): Promise<Record<string, unknown>> {
    if (isOpenCodeGoVisionDiagnosticWorkflowPayload(event.payload)) {
      return runOpenCodeGoVisionDiagnosticWorkflow(this.env, event.payload, step);
    }
    if (isOpenCodeGoCapabilityWorkflowPayload(event.payload)) {
      return runOpenCodeGoCapabilityWorkflow(this.env, event.payload, step);
    }
    if (isCapabilityWorkflowPayload(event.payload)) {
      return runVisualClassifierCapabilityWorkflow(this.env, event.payload, step);
    }
    return super.run(event, step);
  }
}

export { AuthState, OneDriveMCP, PaidCoordinator, PaidConnectorWorkflow };
export default patchedDefault;
