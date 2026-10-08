import type { CanonicalChatSafeError } from "@matrix-os/contracts";

/** Historical SDK bindings remain readable, but cannot execute Matrix-funded work. */
export function isRetiredMatrixSdkInstance(instanceId: string): boolean {
  return instanceId === "kernel_matrix_included";
}

export function matrixSdkRetirementError(): CanonicalChatSafeError {
  return {
    code: "model_unavailable",
    safeMessage: "Start a new Chat to use Matrix AI.",
    retryable: false,
    recoveryActions: ["start_new_chat"],
  };
}
