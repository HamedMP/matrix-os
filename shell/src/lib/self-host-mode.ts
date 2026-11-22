export function isSelfHostedDocument(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.documentElement?.dataset.matrixSelfHosted === "1";
}

export function isSelfHostedRuntime(): boolean {
  if (isSelfHostedDocument()) {
    return true;
  }
  return typeof process !== "undefined" && process.env.MATRIX_SELF_HOSTED === "1";
}

/** "owned" when this computer is enrolled through the platform (spec 2707), otherwise null. */
export function runtimeSubstrate(): string | null {
  if (typeof document !== "undefined" && document.documentElement?.dataset.matrixSubstrate === "owned") return "owned";
  return typeof process !== "undefined" && process.env.MATRIX_SUBSTRATE === "owned" ? "owned" : null;
}

export const SELF_HOSTED_SHELL_USER_ID = "self-hosted-owner";
