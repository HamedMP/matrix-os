import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod/v4";
import {
  MissingRequestPrincipalError,
  InvalidRequestPrincipalError,
  RequestPrincipalMisconfiguredError,
} from "../request-principal.js";
import type { MessagingSafeErrorCode } from "./schemas.js";

export class MessagingError extends Error {
  constructor(
    public readonly code: MessagingSafeErrorCode,
    message: string,
    public readonly status: ContentfulStatusCode,
  ) {
    super(message);
    this.name = "MessagingError";
  }
}

export interface MessagingErrorEnvelope {
  error: {
    code: MessagingSafeErrorCode;
    message: string;
  };
}

const SAFE_MESSAGES: Record<MessagingSafeErrorCode, string> = {
  bad_request: "Invalid request",
  unauthorized: "Unauthorized",
  forbidden: "Forbidden",
  not_found: "Not found",
  conflict: "Conflict",
  expired: "Expired",
  body_too_large: "Request body too large",
  provider_unavailable: "Messaging provider unavailable",
  misconfigured: "Messaging is not configured",
  internal_error: "Messaging request failed",
};

const STATUS_BY_CODE: Record<MessagingSafeErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  expired: 410,
  body_too_large: 413,
  provider_unavailable: 503,
  misconfigured: 503,
  internal_error: 500,
};

export function redactMessagingErrorDetail(value: unknown): string {
  if (value instanceof Error) return value.name;
  if (typeof value === "string") return value.slice(0, 80).replace(/[^\w .:-]/g, "?");
  return typeof value;
}

export function toMessagingErrorEnvelope(code: MessagingSafeErrorCode): MessagingErrorEnvelope {
  return {
    error: {
      code,
      message: SAFE_MESSAGES[code],
    },
  };
}

export function mapMessagingError(err: unknown): { status: ContentfulStatusCode; body: MessagingErrorEnvelope; log: boolean } {
  if (err instanceof MessagingError) {
    return {
      status: err.status,
      body: toMessagingErrorEnvelope(err.code),
      log: err.status >= 500,
    };
  }
  if (err instanceof ZodError) {
    return {
      status: STATUS_BY_CODE.bad_request,
      body: toMessagingErrorEnvelope("bad_request"),
      log: false,
    };
  }
  if (err instanceof MissingRequestPrincipalError || err instanceof InvalidRequestPrincipalError) {
    return {
      status: STATUS_BY_CODE.unauthorized,
      body: toMessagingErrorEnvelope("unauthorized"),
      log: false,
    };
  }
  if (err instanceof RequestPrincipalMisconfiguredError) {
    return {
      status: STATUS_BY_CODE.misconfigured,
      body: toMessagingErrorEnvelope("misconfigured"),
      log: true,
    };
  }
  if (err instanceof SyntaxError) {
    return {
      status: STATUS_BY_CODE.bad_request,
      body: toMessagingErrorEnvelope("bad_request"),
      log: false,
    };
  }
  if (err instanceof Error && err.name === "BodyLimitError") {
    return {
      status: STATUS_BY_CODE.body_too_large,
      body: toMessagingErrorEnvelope("body_too_large"),
      log: false,
    };
  }
  return {
    status: STATUS_BY_CODE.internal_error,
    body: toMessagingErrorEnvelope("internal_error"),
    log: true,
  };
}

export function statusForMessagingErrorCode(code: MessagingSafeErrorCode): ContentfulStatusCode {
  return STATUS_BY_CODE[code];
}
