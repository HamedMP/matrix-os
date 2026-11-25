/**
 * The one failure type every mail and calendar adapter throws.
 *
 * Adapters never surface a provider's own error text: it can contain account
 * details, internal paths or upstream names. They pick a code, and the message
 * is one of the fixed sentences below (or a short adapter-written one).
 */
export const PROVIDER_ERROR_CODES = ["not_connected", "multiple_accounts", "rate_limited", "not_supported", "failed"] as const;

/**
 * - `not_connected`: no account of this provider is connected. Offer to connect one.
 * - `multiple_accounts`: several accounts match and none was chosen. Ask which one.
 * - `rate_limited`: too many requests. Retry after a pause; keep cached data visible.
 * - `not_supported`: this provider cannot do the requested thing. Do not retry.
 * - `failed`: anything else (timeout, upstream fault, unexpected reply). Retryable.
 */
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** The plain shape of a provider failure; also what survives JSON or a structured clone. */
export interface ProviderErrorShape {
  code: ProviderErrorCode;
  message: string;
}

export const PROVIDER_ERROR_MESSAGES: Readonly<Record<ProviderErrorCode, string>> = Object.freeze({
  not_connected: "This account is not connected.",
  multiple_accounts: "More than one account is connected. Choose one.",
  rate_limited: "Too many requests. Try again in a moment.",
  not_supported: "This account does not support that action.",
  failed: "Something went wrong. Try again.",
});

const MAX_MESSAGE_LENGTH = 160;

function safeMessage(code: ProviderErrorCode, message: string | undefined): string {
  if (message === undefined) return PROVIDER_ERROR_MESSAGES[code];
  const flat = message.replace(/\s+/g, " ").trim();
  if (!flat) return PROVIDER_ERROR_MESSAGES[code];
  return flat.length > MAX_MESSAGE_LENGTH ? `${flat.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : flat;
}

export class ProviderError extends Error implements ProviderErrorShape {
  readonly code: ProviderErrorCode;

  /**
   * `message` is optional adapter-written, owner-facing text. It is flattened to
   * one line and capped. Never pass a provider's or the gateway's error text.
   */
  constructor(code: ProviderErrorCode, message?: string) {
    super(safeMessage(code, message));
    this.name = "ProviderError";
    this.code = code;
  }
}

function isCode(value: unknown): value is ProviderErrorCode {
  return typeof value === "string" && (PROVIDER_ERROR_CODES as readonly string[]).includes(value);
}

/** Structural check, so it also recognises an error that crossed a JSON boundary. */
export function isProviderError(value: unknown): value is ProviderErrorShape {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return isCode(candidate.code) && typeof candidate.message === "string";
}

/**
 * Turns anything caught into a `ProviderError`. A `ProviderError` passes through
 * unchanged. Everything else keeps only a recognised code; its text is dropped
 * and replaced by the fixed sentence for that code.
 */
export function toProviderError(value: unknown): ProviderError {
  if (value instanceof ProviderError) return value;
  return new ProviderError(isProviderError(value) ? value.code : "failed");
}

/**
 * Maps the status of a failed `MatrixOS.service(...)` call to a code:
 * 404 no matching account, 409 several accounts and no label given, 429 the
 * app request budget is used up. Every other failure is `failed`.
 */
export function providerErrorCodeForStatus(status: number): ProviderErrorCode {
  if (status === 404) return "not_connected";
  if (status === 409) return "multiple_accounts";
  if (status === 429) return "rate_limited";
  return "failed";
}

/** Whether showing a "Try again" action makes sense for this failure. */
export function isRetryableProviderError(value: unknown): boolean {
  return isProviderError(value) && (value.code === "rate_limited" || value.code === "failed");
}
