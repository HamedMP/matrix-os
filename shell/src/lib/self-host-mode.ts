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
