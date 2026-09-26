import type { Context } from "hono";
import type { PlatformDb } from "../platform-db.js";
import { IntegrationActionNotImplementedError } from "./action-execution.js";
import { SYMPHONY_LINEAR_ACTIONS, classifySymphonyGraphqlFailure, type SymphonyGraphqlFailure } from "./symphony-linear.js";

function isSymphonyAction(service: string, action: string): boolean {
  return service === "linear" && Object.hasOwn(SYMPHONY_LINEAR_ACTIONS, action);
}

function symphonyFailureResponse(c: Context, kind: SymphonyGraphqlFailure, action: string): Response {
  if (kind === "operation") {
    return c.json({ service: "linear", action, data: { errors: [{ extensions: { code: "OPERATION_FAILED" } }] } });
  }
  if (kind === "rate_limited") {
    return c.json({ error: "Please retry later", code: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  if (kind === "configuration") {
    return c.json({ error: "Integration setup required", code: "configuration_error" }, 422);
  }
  return c.json({ error: "Integration temporarily unavailable", code: "transient_failure" }, 503);
}

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
  if (isSymphonyAction(service, action)) {
    const failure = classifySymphonyGraphqlFailure(data);
    if (failure) return symphonyFailureResponse(c, failure, action);
  }
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
  if (err instanceof IntegrationActionNotImplementedError) {
    console.error(`[integrations] Action ${err.serviceId}/${err.actionId} has neither componentKey nor directApi -- registry incomplete`);
    return c.json({ error: "Action not available" }, 501);
  }
  const upstreamStatus = getErrorStatusCode(err);
  if (isSymphonyAction(service, action) && upstreamStatus === 400) {
    const body = err && typeof err === "object" && "body" in err ? err.body : undefined;
    const failure = classifySymphonyGraphqlFailure(body);
    if (failure) return symphonyFailureResponse(c, failure, action);
  }
  if (isSymphonyAction(service, action) && upstreamStatus
      && upstreamStatus >= 400 && upstreamStatus < 500 && ![408, 429].includes(upstreamStatus)) {
    return c.json({ error: "Integration setup required", code: "provider_rejected" }, 422);
  }
  if (upstreamStatus === 429) {
    const retryAfter = getRetryAfterSeconds(err);
    return c.json(
      { error: "Rate limited by provider. Please try again later.", retry_after: retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  if (isSymphonyAction(service, action)) {
    console.warn("[integrations] symphony_call outcome=transient_failure");
    return c.json({ error: "Integration temporarily unavailable", code: "transient_failure" }, 503);
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
