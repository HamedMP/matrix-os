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

export type ZellijOutputErrorReason = "non_json" | "schema_invalid";

const ZELLIJ_OUTPUT_SNIPPET_MAX = 160;
// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]+/g;
// Long opaque runs may be credentials; Zellij output never needs them for diagnosis.
const TOKEN_LIKE_RUN = /[A-Za-z0-9+/=_-]{48,}/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

/** Bounded, ANSI-free, control-free, token-redacted excerpt that is safe for server logs. */
export function zellijOutputSnippet(output: string): string {
  const cleaned = stripAnsi(output.slice(0, 4_096))
    .replace(CONTROL_CHARACTERS, " ")
    .replace(TOKEN_LIKE_RUN, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > ZELLIJ_OUTPUT_SNIPPET_MAX
    ? `${cleaned.slice(0, ZELLIJ_OUTPUT_SNIPPET_MAX - 3)}...`
    : cleaned;
}

/**
 * Zellij answered a structured (`--json`) command with output that is not the
 * expected JSON, e.g. a stale older-generation server printing a coloured
 * "session not found" line. The snippet is for server logs only; clients see
 * the generic `unavailable` message.
 */
export class ZellijOutputError extends TerminalRuntimeError {
  readonly reason: ZellijOutputErrorReason;
  readonly snippet: string;

  constructor(reason: ZellijOutputErrorReason, snippet: string, options?: ErrorOptions) {
    super("unavailable", undefined, options);
    this.name = "ZellijOutputError";
    this.reason = reason;
    this.snippet = snippet;
  }

  static fromOutput(reason: ZellijOutputErrorReason, output: string, options?: ErrorOptions): ZellijOutputError {
    return new ZellijOutputError(reason, zellijOutputSnippet(output), options);
  }
}
