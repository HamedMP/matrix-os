export type CodexFailureReason = "authentication_required" | "usage_limit" | "credit_required" | "billing_required";
export function codexTerminalFailureReason(value: unknown): CodexFailureReason | undefined;
