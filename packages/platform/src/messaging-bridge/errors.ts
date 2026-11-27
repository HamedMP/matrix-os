import type { Context } from "hono";
import type { MessagingBridgeErrorCode } from "@matrix-os/contracts/messaging-bridge";

/**
 * One typed error and one mapper for every messaging-bridge route. Clients
 * only ever see the code and a fixed message; the cause is logged server-side
 * through `describeForLog`, which never includes message text, bodies or URLs.
 */
export class MessagingBridgeHttpError extends Error {
  readonly code: MessagingBridgeErrorCode;
  /** Safe diagnostic tags only (status codes, Matrix errcodes, stage names). */
  readonly detail: Readonly<Record<string, string | number>>;

  constructor(code: MessagingBridgeErrorCode, detail: Record<string, string | number> = {}, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "MessagingBridgeHttpError";
    this.code = code;
    this.detail = detail;
  }
}

const STATUS: Record<MessagingBridgeErrorCode, 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503> = {
  unauthorized: 401,
  forbidden: 403,
  not_enabled: 403,
  not_found: 404,
  invalid_request: 400,
  conflict: 409,
  rate_limited: 429,
  bridge_unavailable: 502,
  misconfigured: 503,
  internal: 500,
};

const MESSAGE: Record<MessagingBridgeErrorCode, string> = {
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  not_enabled: "Messaging is not available for this account yet",
  not_found: "Not found",
  invalid_request: "Invalid request",
  conflict: "The request conflicts with the current state",
  rate_limited: "Too many requests, try again later",
  bridge_unavailable: "Messaging is temporarily unavailable",
  misconfigured: "Messaging is not configured",
  internal: "Internal error",
};

export function errorBody(code: MessagingBridgeErrorCode) {
  return { error: { code, message: MESSAGE[code] } };
}

export function respondWithError(c: Context, code: MessagingBridgeErrorCode, status: number = STATUS[code]) {
  c.header("Cache-Control", "no-store");
  return c.json(errorBody(code), status as 400);
}

export interface MessagingBridgeLogger {
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/** Log-safe summary of any thrown value: the error class and its safe tags, never its message. */
export function describeForLog(error: unknown): Record<string, unknown> {
  if (error instanceof MessagingBridgeHttpError) {
    return { error: error.name, code: error.code, ...error.detail, ...(error.cause ? { cause: causeName(error.cause) } : {}) };
  }
  return { error: causeName(error) };
}

function causeName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

/** The single mapper from any thrown value to a client response. */
export function mapErrorToResponse(c: Context, error: unknown, log: MessagingBridgeLogger, stage: string) {
  if (error instanceof MessagingBridgeHttpError) {
    if (STATUS[error.code] >= 500) log.error(`[messaging-bridge] ${stage} failed`, describeForLog(error));
    return respondWithError(c, error.code);
  }
  log.error(`[messaging-bridge] ${stage} crashed`, describeForLog(error));
  return respondWithError(c, "internal");
}
