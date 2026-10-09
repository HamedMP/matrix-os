/**
 * Connector sources: one bounded provider call. Each call gets the run signal plus its own timeout; outcomes become
 * stable source error codes and provider JSON is parsed with a bounded zod schema before any adapter reads it.
 * Provider text never leaves server logs, and logs carry names and codes only.
 */
import { z } from "zod/v4";
import {
  BRAIN_INTEGRATION_RETRY_AFTER_MAX_SECONDS, type BrainIntegrationCaller, type BrainIntegrationCallOutcome,
  type BrainIntegrationCallRequest, type BrainSourceErrorCode,
} from "../../contracts.js";

export type ConnectorResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: BrainSourceErrorCode; readonly retryAfterSeconds?: number };

export interface ProviderCallContext {
  readonly integrations: BrainIntegrationCaller; readonly ownerId: string; readonly timeoutMs: number; readonly signal: AbortSignal;
}
/** A call context before a page supplies its signal. */
export type ProviderCall = Omit<ProviderCallContext, "signal">;

/** A provider string of at most `max` UTF-16 units. */
export const text = (max: number) => z.string().max(max);

export function failure(code: BrainSourceErrorCode, retryAfterSeconds?: number): ConnectorResult<never> {
  return retryAfterSeconds === undefined ? { ok: false, code } : { ok: false, code, retryAfterSeconds };
}

export function clampRetryAfter(seconds: number): number {
  if (!Number.isFinite(seconds)) return 60;
  return Math.min(BRAIN_INTEGRATION_RETRY_AFTER_MAX_SECONDS, Math.max(1, Math.ceil(seconds)));
}

function outcomeFailure(outcome: Exclude<BrainIntegrationCallOutcome, { status: "ok" }>): ConnectorResult<never> {
  switch (outcome.status) {
    case "not_connected": return failure("not_connected");
    case "unauthorized": return failure("auth_failed");
    case "rate_limited": return failure("rate_limited", clampRetryAfter(outcome.retryAfterSeconds));
    case "not_found": return failure("remote_not_found");
    case "invalid": return failure("config_invalid");
    default: return failure("provider_unavailable");
  }
}

/**
 * Runs `call` under AbortSignal.any([run signal, timeout]) and stops waiting when that signal aborts, even if the
 * callee ignores it. The run signal aborting rethrows (the runner stops the run); the timeout alone is provider_timeout.
 */
export async function withCallTimeout<T>(
  signal: AbortSignal, timeoutMs: number, call: (signal: AbortSignal) => Promise<T>,
): Promise<ConnectorResult<T>> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const settled = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    combined.addEventListener("abort", () => reject(combined.reason), { once: true, signal: settled.signal });
  });
  try {
    combined.throwIfAborted();
    return { ok: true, value: await Promise.race([call(combined), aborted]) };
  } catch (error) {
    if (!signal.aborted && timeout.aborted) return failure("provider_timeout");
    throw error;
  } finally {
    settled.abort();
  }
}

/** One registry read action; `data` is parsed with `schema` (strips unknown keys, bounded lengths). */
export async function callProvider<T>(
  context: ProviderCallContext, request: BrainIntegrationCallRequest, schema: z.ZodType<T>,
): Promise<ConnectorResult<T>> {
  const called = await withCallTimeout(
    context.signal, context.timeoutMs,
    (signal) => context.integrations.call(context.ownerId, request, signal),
  );
  if (!called.ok) return called;
  const outcome = called.value;
  if (outcome.status !== "ok") return outcomeFailure(outcome);
  const parsed = schema.safeParse(outcome.data);
  if (!parsed.success) {
    console.warn("[brain-connectors] provider output refused", { service: request.service, action: request.action });
    return failure("provider_output_invalid");
  }
  return { ok: true, value: parsed.data };
}
