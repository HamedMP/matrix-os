export const CODEX_FAILURE_REASONS: readonly [
  "authentication_required",
  "usage_limit",
  "credit_required",
  "billing_required",
  "rate_limited",
  "request_timeout",
  "execution_timeout",
  "connection_failed",
  "service_busy",
  "service_failed",
  "context_limit",
  "session_budget",
  "permission_denied",
  "policy_blocked",
  "invalid_request",
  "environment_failed",
  "history_unavailable",
];
export type CodexFailureReason = (typeof CODEX_FAILURE_REASONS)[number];
export function codexTerminalFailureReason(value: unknown): CodexFailureReason | undefined;
export class CodexExecutionTimeout extends Error { constructor(); }
export function codexExecutionFailureReason(error: unknown): "execution_timeout" | undefined;
