export const TERMINAL_RUNTIME_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "conflict",
  "confirmation_required",
  "capacity",
  "unavailable",
  "failed",
] as const;

export type TerminalRuntimeErrorCode = typeof TERMINAL_RUNTIME_ERROR_CODES[number];

export const TERMINAL_RUNTIME_PROTOCOL_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "conflict",
  "unavailable",
  "failed",
] as const;

export type TerminalRuntimeProtocolErrorCode = typeof TERMINAL_RUNTIME_PROTOCOL_ERROR_CODES[number];

const SAFE_MESSAGES: Record<TerminalRuntimeErrorCode, string> = {
  invalid_request: "Invalid terminal runtime request",
  not_found: "Terminal operation failed",
  conflict: "Terminal state changed",
  confirmation_required: "Terminal termination confirmation required",
  capacity: "Terminal capacity reached",
  unavailable: "Terminal operation unavailable",
  failed: "Terminal operation failed",
};

export class TerminalRuntimeError extends Error {
  readonly code: TerminalRuntimeErrorCode;

  constructor(code: TerminalRuntimeErrorCode, message = SAFE_MESSAGES[code], options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalRuntimeError";
    this.code = code;
  }
}

export function terminalRuntimeErrorDetails(error: unknown): {
  code: TerminalRuntimeProtocolErrorCode;
  message: string;
} {
  if (error instanceof TerminalRuntimeError) {
    const code = error.code === "confirmation_required" || error.code === "capacity"
      ? "conflict"
      : error.code;
    return { code, message: SAFE_MESSAGES[error.code] };
  }
  return { code: "failed", message: SAFE_MESSAGES.failed };
}

export function terminalRuntimeErrorFromDetails(input: {
  code: TerminalRuntimeProtocolErrorCode;
  message: string;
}): TerminalRuntimeError {
  if (input.code === "conflict" && input.message === SAFE_MESSAGES.confirmation_required) {
    return new TerminalRuntimeError("confirmation_required");
  }
  if (input.code === "conflict" && input.message === SAFE_MESSAGES.capacity) {
    return new TerminalRuntimeError("capacity");
  }
  return new TerminalRuntimeError(input.code);
}
