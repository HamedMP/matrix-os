import { z } from "zod/v4";

const NativeErrorSchema = z.object({
  message: z.string().max(4096).optional(),
  codexErrorInfo: z.unknown().optional(),
}).passthrough();
export const CODEX_FAILURE_REASONS = [
  "authentication_required", "usage_limit", "credit_required", "billing_required",
  "rate_limited", "execution_timeout", "request_timeout", "connection_failed", "service_busy", "service_failed",
  "context_limit", "session_budget", "permission_denied", "policy_blocked", "invalid_request",
  "environment_failed", "history_unavailable",
];
export class CodexExecutionTimeout extends Error {
  constructor() { super("Coding execution deadline exceeded"); this.name = "CodexExecutionTimeout"; }
}

export function codexExecutionFailureReason(error) {
  return error instanceof CodexExecutionTimeout ? "execution_timeout" : undefined;
}

const HttpStatusSchema = z.number().int().min(100).max(599).nullable();
const HttpErrorInfoSchema = z.union([
  z.object({ httpConnectionFailed: z.object({ httpStatusCode: HttpStatusSchema }).strict() }).strict(),
  z.object({ responseStreamConnectionFailed: z.object({ httpStatusCode: HttpStatusSchema }).strict() }).strict(),
  z.object({ responseStreamDisconnected: z.object({ httpStatusCode: HttpStatusSchema }).strict() }).strict(),
  z.object({ responseTooManyFailedAttempts: z.object({ httpStatusCode: HttpStatusSchema }).strict() }).strict(),
]);
const TYPED_REASONS = {
  unauthorized: "authentication_required", usageLimitExceeded: "usage_limit",
  contextWindowExceeded: "context_limit", sessionBudgetExceeded: "session_budget",
  serverOverloaded: "service_busy", internalServerError: "service_failed",
  cyberPolicy: "policy_blocked", badRequest: "invalid_request",
  sandboxError: "environment_failed", threadRollbackFailed: "history_unavailable",
};

/** Classify native terminal errors only. Never persist raw provider error text. */
export function codexTerminalFailureReason(value) {
  const parsed = NativeErrorSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { codexErrorInfo: info, message } = parsed.data;
  if (typeof info === "string" && Object.hasOwn(TYPED_REASONS, info)) return TYPED_REASONS[info];
  const http = HttpErrorInfoSchema.safeParse(info);
  if (http.success) {
    const status = Object.values(http.data)[0].httpStatusCode;
    if (status === 401) return "authentication_required";
    if (status === 402) return "billing_required";
    if (status === 403) return "permission_denied";
    if (status === 429) return "rate_limited";
    if (status === 408 || status === 504) return "request_timeout";
    if (status === 503) return "service_busy";
    if (status !== null && status >= 500) return "service_failed";
    if (status === null) return "connection_failed";
    return undefined;
  }
  // Older workspace discovery errors publish only text. Limit recognition to
  // established native error prefixes; tool output and ordinary text never enter here.
  if (info !== undefined && info !== null && info !== "other") return undefined;
  if (typeof message === "string" && (
    /^workspace routing discovery unauthorized \(401\)(?:$|[.:;\s])/.test(message)
    || /^Your access token could not be refreshed because your refresh token was revoked\./.test(message)
    || /^Not logged in(?:[.!]|$)/i.test(message)
  )) return "authentication_required";
  return undefined;
}
