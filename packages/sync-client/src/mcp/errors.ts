export type SafeMcpErrorCode =
  | "invalid_input"
  | "auth_required"
  | "computer_not_found"
  | "computer_unavailable"
  | "not_found"
  | "conflict"
  | "payload_too_large"
  | "request_timeout"
  | "request_failed";

export interface SafeMcpError {
  code: SafeMcpErrorCode;
  message: string;
  retryable: boolean;
}

const ERRORS: Record<SafeMcpErrorCode, Omit<SafeMcpError, "code">> = {
  invalid_input: { message: "The Matrix tool input is invalid.", retryable: false },
  auth_required: { message: "Authenticate with the Matrix CLI and try again.", retryable: false },
  computer_not_found: { message: "That Matrix computer is not available to this account.", retryable: false },
  computer_unavailable: { message: "That Matrix computer is not currently available.", retryable: true },
  not_found: { message: "The requested Matrix resource was not found.", retryable: false },
  conflict: { message: "The Matrix resource already exists or changed.", retryable: false },
  payload_too_large: { message: "The Matrix tool payload exceeds its size limit.", retryable: false },
  request_timeout: { message: "The Matrix request timed out.", retryable: true },
  request_failed: { message: "Matrix could not complete the request.", retryable: true },
};

const CODE_MAP: Record<string, SafeMcpErrorCode> = {
  auth_expired: "auth_required",
  auth_rejected: "auth_required",
  not_authenticated: "auth_required",
  computer_not_found: "computer_not_found",
  computer_unavailable: "computer_unavailable",
  invalid_input: "invalid_input",
  invalid_remote_path: "invalid_input",
  remote_file_not_found: "not_found",
  not_found: "not_found",
  remote_file_exists: "conflict",
  conflict: "conflict",
  payload_too_large: "payload_too_large",
  request_timeout: "request_timeout",
};

export function createMcpError(code: SafeMcpErrorCode): Error & { code: SafeMcpErrorCode } {
  return Object.assign(new Error(code), { code });
}

export function toSafeMcpError(error: unknown): SafeMcpError {
  if (error instanceof ZodError) {
    return { code: "invalid_input", ...ERRORS.invalid_input };
  }
  const rawCode = error instanceof Error && "code" in error
    ? String((error as Error & { code?: unknown }).code)
    : "";
  const code = CODE_MAP[rawCode] ?? "request_failed";
  return { code, ...ERRORS[code] };
}

export function safeErrorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: toSafeMcpError(error) }) }],
  };
}

export function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}
import { ZodError } from "zod/v4";
