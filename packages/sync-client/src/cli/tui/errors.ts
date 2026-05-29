export const GENERIC_TUI_ERROR_MESSAGE = "Request failed";
export const MAX_TUI_ERROR_MESSAGE_LENGTH = 240;

const SAFE_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const SAFE_CODES = new Set([
  "action_unavailable",
  "cancelled",
  "gateway_unavailable",
  "request_failed",
  "not_authenticated",
  "profile_not_found",
  "timeout",
  "invalid_request",
  "daemon_unavailable",
  "daemon_timeout",
  "invalid_response",
]);

export interface TuiSafeError extends Error {
  code: string;
  recoverable: boolean;
}

export function isSafeErrorCode(code: unknown): code is string {
  return typeof code === "string" && SAFE_CODE.test(code) && SAFE_CODES.has(code);
}

export function createTuiSafeError(
  code: string = "request_failed",
  options: { message?: string; recoverable?: boolean } = {},
): TuiSafeError {
  const safeCode = isSafeErrorCode(code) ? code : "request_failed";
  const error = new Error(capTuiMessage(options.message ?? GENERIC_TUI_ERROR_MESSAGE)) as TuiSafeError;
  error.code = safeCode;
  error.recoverable = options.recoverable ?? true;
  return error;
}

export function normalizeTuiError(error: unknown): TuiSafeError {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return createTuiSafeError(isSafeErrorCode(code) ? code : "request_failed", {
      message: safeTuiMessageFromError(error),
    });
  }
  if (typeof error === "object" && error !== null) {
    const code = "code" in error ? (error as { code?: unknown }).code : undefined;
    const message = "message" in error ? (error as { message?: unknown }).message : undefined;
    return createTuiSafeError(isSafeErrorCode(code) ? code : "request_failed", {
      message: typeof message === "string" ? safeTuiMessage(message) : GENERIC_TUI_ERROR_MESSAGE,
    });
  }
  return createTuiSafeError("request_failed");
}

export function codeFromErrorPayload(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return "request_failed";
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") {
    return isSafeErrorCode(error) ? error : "request_failed";
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return isSafeErrorCode(code) ? code : "request_failed";
  }
  return "request_failed";
}

export function capTuiMessage(message: string, maxLength: number = MAX_TUI_ERROR_MESSAGE_LENGTH): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength);
}

function looksUnsafeForTui(message: string): boolean {
  return /(?:https?:\/\/|postgres:\/\/|file:\/\/|\/home\/|\/Users\/|[A-Za-z]:\\|\.env\b|token|secret|stack trace| at \S+\(|node_modules)/i.test(message);
}

export function safeTuiMessage(message: string): string {
  const capped = capTuiMessage(message);
  if (!capped || looksUnsafeForTui(capped)) {
    return GENERIC_TUI_ERROR_MESSAGE;
  }
  return capped;
}

export function safeTuiMessageFromError(error: unknown): string {
  if (error instanceof Error) {
    return safeTuiMessage(error.message);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? safeTuiMessage(message) : GENERIC_TUI_ERROR_MESSAGE;
  }
  if (typeof error === "string") {
    return safeTuiMessage(error);
  }
  return GENERIC_TUI_ERROR_MESSAGE;
}
