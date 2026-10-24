import { NativeGmailHistoryExpiredError } from "./native-gmail/request.js";
import type { Context } from "hono";
import type { PlatformDb } from "../platform-db.js";
import { IntegrationActionNotImplementedError } from "./action-execution.js";
import { DriveContentError } from "./drive-content.js";

export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("enetunreach");
}

export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError" || err.message.includes("timed out");
}

// Pipedream SDK throws PipedreamError { statusCode, rawResponse }, while legacy
// callers and test doubles may use { status, headers }.
export function getErrorStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { statusCode?: number; status?: number; rawResponse?: { status?: number } };
  return e.statusCode ?? e.status ?? e.rawResponse?.status;
}

export function getRetryAfterSeconds(err: unknown, fallback = 60): number {
  if (!err || typeof err !== "object") return fallback;
  const e = err as {
    headers?: Record<string, string> | { get?: (k: string) => string | null };
    rawResponse?: { headers?: { get?: (k: string) => string | null } };
  };
  let raw: string | null | undefined;
  if (e.rawResponse?.headers?.get) {
    raw = e.rawResponse.headers.get("retry-after");
  } else if (e.headers && typeof (e.headers as { get?: unknown }).get === "function") {
    raw = (e.headers as { get: (k: string) => string | null }).get("retry-after");
  } else if (e.headers && typeof e.headers === "object") {
    raw = (e.headers as Record<string, string>)["retry-after"];
  }
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Shared post-provider response classification and usage accounting for /call and /read-call. */
export async function integrationActionSuccess(c: Context, input: {
  db: Pick<PlatformDb, "touchServiceUsage">;
  connectionId: string;
  service: string;
  action: string;
  data: unknown;
  summary?: string;
}): Promise<Response> {
  const { db, connectionId, service, action, data, summary } = input;
  try {
    await db.touchServiceUsage(connectionId);
  } catch (err: unknown) {
    // Usage metadata is best effort after the provider has already succeeded.
    // Losing that result would encourage the caller to repeat the action.
    console.error("[integrations] usage timestamp update failed:", err);
  }
  return c.json({ data, service, action, ...(summary ? { summary } : {}) });
}

/** Preserve general call's safe provider failure mapping for scoped reads. */
export function integrationActionFailure(c: Context, err: unknown, service: string, action: string): Response {
  if (err instanceof NativeGmailHistoryExpiredError) {
    return c.json({ error: "Mailbox history expired. Run a bounded resync before continuing.", code: err.code, resync_required: true }, 409);
  }
  if (err instanceof DriveContentError) {
    const messages = {
      unsupported_file_type: "This file type cannot be read as text. Choose a text file or a supported document export.",
      file_too_large: "This file exceeds the 512 KiB text-read limit.",
      file_access_denied: "File content access was denied. Check the account permissions and download restrictions.",
      file_not_found: "The file could not be found for this account.",
      rate_limited: "Too many requests. Please try again later.",
      read_failed: "File content could not be read. Please try again later.",
    };
    const status = err.code === "rate_limited" ? 429 : err.code === "unsupported_file_type" ? 422
      : err.code === "file_too_large" ? 413 : err.code === "file_access_denied" ? 403 : err.code === "file_not_found" ? 404 : 502;
    return c.json({ error: messages[err.code], code: err.code }, status);
  }
  if (err instanceof IntegrationActionNotImplementedError) {
    console.error(`[integrations] Action ${err.serviceId}/${err.actionId} has neither componentKey nor directApi -- registry incomplete`);
    return c.json({ error: "Action not available" }, 501);
  }
  const upstreamStatus = getErrorStatusCode(err);
  if (upstreamStatus === 429) {
    const retryAfter = getRetryAfterSeconds(err);
    return c.json(
      { error: "Rate limited by provider. Please try again later.", retry_after: retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  if (isTimeoutError(err)) {
    console.error(`[integrations] callAction timeout for ${service}/${action}`);
    return c.json({ error: "Integration call timed out" }, 504);
  }
  if (isConnectionError(err)) {
    console.error(`[integrations] callAction connection error for ${service}/${action}:`, err);
    return c.json({ error: "Integration service unavailable" }, 503);
  }
  console.error(`[integrations] callAction error for ${service}/${action}:`, err);
  return c.json({ error: "Integration call failed" }, 502);
}
