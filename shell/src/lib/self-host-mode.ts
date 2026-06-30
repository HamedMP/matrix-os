export function isSelfHostedDocument(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return document.documentElement?.dataset.matrixSelfHosted === "1";
}
