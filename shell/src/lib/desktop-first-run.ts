export type DesktopFirstRunStatus = "checking" | "first-run" | "ready";

export function parseDesktopFirstRunStatus(value: unknown): DesktopFirstRunStatus {
  if (!value || typeof value !== "object") throw new Error("invalid onboarding status");
  const complete = (value as { complete?: unknown }).complete;
  if (typeof complete !== "boolean") throw new Error("invalid onboarding status");
  return complete ? "ready" : "first-run";
}

export function shouldApplyInitialDesktopDefaults(status: DesktopFirstRunStatus): boolean {
  return status === "first-run";
}
