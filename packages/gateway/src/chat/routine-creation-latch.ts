import type { CanonicalProviderRunInput } from "./provider-adapter.js";

export interface RoutineCreationLatch {
  claim(engine: "native" | "matrix"): boolean;
}

/** Claude reserves native creation for the entire phase. An old explicit Matrix
 * intent cannot become a native job after a refusal, cancellation or unknown result. */
export function createRoutineCreationLatch(input: Pick<CanonicalProviderRunInput, "context" | "nativeScheduled">): RoutineCreationLatch {
  const nativeAllowed = Boolean(input.nativeScheduled) || input.context?.routineCreation !== "matrix";
  return { claim: engine => engine === "native" && nativeAllowed };
}
