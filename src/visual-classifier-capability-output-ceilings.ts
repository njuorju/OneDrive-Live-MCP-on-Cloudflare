import { ConnectorError } from "./errors";
import type { CapabilityStage } from "./visual-classifier-capability-common";

export type ZenResponsesOutputCapabilityStage = Exclude<CapabilityStage, "model_discovery">;

// ODL-REQ-034 keeps every billable capability stage explicit, bounded, and fail-closed.
export const ZEN_RESPONSES_CAPABILITY_OUTPUT_CEILINGS: Readonly<Record<ZenResponsesOutputCapabilityStage, number>> = Object.freeze({
  text_structured_output: 128,
  vision_unstructured: 1024,
  vision_structured_output: 1024,
});

export function zenResponsesCapabilityOutputCeiling(stage: CapabilityStage | string): number {
  switch (stage) {
    case "text_structured_output":
      return ZEN_RESPONSES_CAPABILITY_OUTPUT_CEILINGS.text_structured_output;
    case "vision_unstructured":
      return ZEN_RESPONSES_CAPABILITY_OUTPUT_CEILINGS.vision_unstructured;
    case "vision_structured_output":
      return ZEN_RESPONSES_CAPABILITY_OUTPUT_CEILINGS.vision_structured_output;
    default:
      throw new ConnectorError(
        "capability_stage_output_ceiling_unconfigured",
        "The capability stage does not have an explicit bounded output-token ceiling.",
      );
  }
}
