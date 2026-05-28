export const GENERIC_TUI_ERROR_MESSAGE = "Request failed";

const SAFE_CODE = /^[a-z][a-z0-9_]{1,63}$/;
const SAFE_CODES = new Set([
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
  const error = new Error(options.message ?? GENERIC_TUI_ERROR_MESSAGE) as TuiSafeError;
  error.code = safeCode;
  error.recoverable = options.recoverable ?? true;
  return error;
}

export function normalizeTuiError(error: unknown): TuiSafeError {
  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return createTuiSafeError(isSafeErrorCode(code) ? code : "request_failed");
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
