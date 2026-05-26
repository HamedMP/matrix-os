import { ZodError } from "zod/v4";
import {
  isRequestPrincipalError,
  mapRequestPrincipalError,
} from "../request-principal.js";

const UNSAFE_CLIENT_ERROR = /(postgres|sqlite|mysql|pipedream|twilio|openai|anthropic|claude|codex|\/home\/|\/tmp\/|stack|constraint|zod|issues|secret|token|key)/i;

export class ActivationRouteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly publicMessage: string;

  constructor(
    code: string,
    publicMessage: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(publicMessage);
    this.name = "ActivationRouteError";
    this.code = code;
    this.status = options.status ?? 400;
    this.retryable = options.retryable ?? false;
    this.publicMessage = publicMessage;
  }
}

export interface SafeActivationError {
  status: number;
  body: {
    error: string;
    message: string;
    retryable: boolean;
  };
}

function isHttpStatusError(err: unknown): err is { status: number } {
  return Boolean(err && typeof err === "object" && typeof (err as { status?: unknown }).status === "number");
}

export function safeClientMessage(value: unknown, fallback = "Request failed"): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || UNSAFE_CLIENT_ERROR.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

export function mapActivationError(err: unknown): SafeActivationError {
  if (err instanceof ActivationRouteError) {
    return {
      status: err.status,
      body: {
        error: err.code,
        message: safeClientMessage(err.publicMessage),
        retryable: err.retryable,
      },
    };
  }

  if (err instanceof ZodError || err instanceof SyntaxError) {
    return {
      status: 400,
      body: {
        error: "invalid_request",
        message: "Request is invalid",
        retryable: false,
      },
    };
  }

  if (
    (isHttpStatusError(err) && err.status === 413) ||
    (err instanceof Error && err.message === "Payload Too Large")
  ) {
    return {
      status: 413,
      body: {
        error: "payload_too_large",
        message: "Request body is too large",
        retryable: false,
      },
    };
  }

  if (isRequestPrincipalError(err)) {
    const mapped = mapRequestPrincipalError(err);
    if (mapped.log) {
      console.error("[onboarding] request principal resolution failed:", err.message);
    }
    return {
      status: mapped.status,
      body: {
        error: mapped.body.error,
        message: mapped.status === 401 ? "Authentication required" : "Request failed",
        retryable: false,
      },
    };
  }

  console.error("[onboarding] unexpected activation route error:", err instanceof Error ? err.message : String(err));
  return {
    status: 500,
    body: {
      error: "internal_error",
      message: "Request failed",
      retryable: true,
    },
  };
}
