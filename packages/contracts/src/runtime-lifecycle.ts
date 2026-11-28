import { z } from "zod/v4";

/**
 * Why a Matrix computer must stay awake. `unknown` means a busy-state source
 * failed or timed out; callers must treat it as busy and never suspend on it.
 */
export const RuntimeBusyReasonSchema = z.enum([
  "chat_run",
  "terminal_attached",
  "background_agent",
  "routine",
  "unknown",
]);
export type RuntimeBusyReason = z.infer<typeof RuntimeBusyReasonSchema>;

/** `GET /api/system/lifecycle` response, read by the platform idle sleeper. */
export const RuntimeLifecycleStatusSchema = z.object({
  busy: z.boolean(),
  busyReasons: z.array(RuntimeBusyReasonSchema).max(RuntimeBusyReasonSchema.options.length),
  /** Earliest future cron or routine time (ISO 8601) among the sources that answered, or null. */
  nextScheduledAt: z.iso.datetime().nullable(),
  /** False when any schedule source failed or timed out; callers must not suspend on an incomplete schedule. */
  scheduleComplete: z.boolean(),
}).strict().refine((status) => status.busy === status.busyReasons.length > 0, {
  message: "busy must match busyReasons",
});
export type RuntimeLifecycleStatus = z.infer<typeof RuntimeLifecycleStatusSchema>;

/**
 * Client policy for a sleeping Matrix computer (spec 2691, ENG-520).
 *
 * The platform wakes a sleeping free-tier computer on the owner's next
 * request. When the wake outlasts that request it answers 503 *before*
 * proxying anything upstream:
 *
 * - `{ runtimeState: "waking" | "starting" }` + `Retry-After: 3`
 * - `{ runtimeState: "busy" }` + `Retry-After: 30` (host at capacity)
 * - `{ code: "runtime_unavailable" }` (substrate down)
 *
 * Retry safety: a body carrying `runtimeState` proves the platform answered
 * the request itself and never forwarded it, so retrying even a mutating
 * request cannot apply it twice. `runtime_unavailable` carries no such
 * guarantee in its contract, so only idempotent requests retry it.
 *
 * Native Mobile and the CLI share this module so the schedule, copy, and
 * error codes cannot drift between clients.
 */

/** Total time a client keeps retrying a waking computer before giving up. */
export const RUNTIME_WAKE_BUDGET_MS = 30_000;
/** The platform can wait 10 s before returning a wake response. Allow time for routing and transit. */
export const RUNTIME_WAKE_ATTEMPT_TIMEOUT_MS = 15_000;
/** A wake shorter than this never shows a notice. */
export const RUNTIME_WAKE_NOTICE_DELAY_MS = 3_000;

const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_RETRY_AFTER_MS = 3_000;
const MAX_JITTER_MS = 1_000;
/** Wake bodies are tiny; anything larger is not one. */
export const MAX_RUNTIME_WAKE_BODY_CHARS = 4_096;

export type RuntimeWakeKind = "waking" | "busy" | "unavailable";
export type RuntimeWakeErrorCode = "runtime_waking" | "runtime_busy" | "runtime_unavailable";

export interface RuntimeWakeSignal {
  kind: RuntimeWakeKind;
  /** Retry-After in milliseconds, clamped to 1..10 s. */
  retryAfterMs: number;
  /** True when the body carried `runtimeState`: the request was never forwarded upstream. */
  notForwarded: boolean;
}

export const RUNTIME_WAKE_MESSAGES = {
  notice: "Waking your Matrix computer…",
  runtime_waking: "Your Matrix computer is still waking up. Try again in a moment.",
  runtime_busy: "Matrix is at capacity right now. Try again in a minute.",
  runtime_unavailable: "Your Matrix computer is unavailable right now. Try again soon.",
} as const satisfies Record<"notice" | RuntimeWakeErrorCode, string>;

export const RUNTIME_WAKE_ERROR_CODES: Record<RuntimeWakeKind, RuntimeWakeErrorCode> = {
  waking: "runtime_waking",
  busy: "runtime_busy",
  unavailable: "runtime_unavailable",
};

/** Typed failure once the wake budget (or the single busy/unavailable retry) is spent. */
export class RuntimeWakeError extends Error {
  readonly code: RuntimeWakeErrorCode;

  constructor(readonly kind: RuntimeWakeKind) {
    const code = RUNTIME_WAKE_ERROR_CODES[kind];
    super(RUNTIME_WAKE_MESSAGES[code]);
    this.name = "RuntimeWakeError";
    this.code = code;
  }
}

/** Delta-seconds Retry-After, clamped to 1..10 s; absent or malformed means 3 s. */
export function parseRetryAfterMs(value: string | null | undefined): number {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d{1,6}$/.test(trimmed)) return DEFAULT_RETRY_AFTER_MS;
  const ms = Number(trimmed) * 1_000;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Classifies an already-parsed response. Only a 503 with a known wake body counts. */
export function classifyRuntimeWakeResponse(
  status: number,
  retryAfter: string | null | undefined,
  body: unknown,
): RuntimeWakeSignal | null {
  if (status !== 503 || !isRecord(body)) return null;
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  const state = body.runtimeState;
  if (state === "waking" || state === "starting") return { kind: "waking", retryAfterMs, notForwarded: true };
  if (state === "busy") return { kind: "busy", retryAfterMs, notForwarded: true };
  if (body.code === "runtime_unavailable") return { kind: "unavailable", retryAfterMs, notForwarded: false };
  return null;
}

/** Parses a wake body from text; anything that is not small JSON is not a wake response. */
export function classifyRuntimeWakeText(
  status: number,
  retryAfter: string | null | undefined,
  text: string,
): RuntimeWakeSignal | null {
  if (status !== 503 || text.length > MAX_RUNTIME_WAKE_BODY_CHARS) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err: unknown) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  return classifyRuntimeWakeResponse(status, retryAfter, body);
}

/**
 * Reads at most `maxBytes` of a cloned body, or null when it is larger. A
 * declared Content-Length over the cap is refused without reading. Runtimes
 * without response streams (React Native's whatwg-fetch resolves only after
 * XHR has the whole body) check the blob size before decoding any text.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  const declared = response.headers?.get?.("content-length");
  if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) return null;
  const clone = response.clone();
  const reader = clone.body && typeof clone.body.getReader === "function" ? clone.body.getReader() : null;
  if (!reader) {
    if (typeof clone.blob === "function") {
      const blob = await clone.blob();
      if (blob.size > maxBytes) return null;
      return response.clone().text();
    }
    const text = await clone.text();
    return text.length > maxBytes ? null : text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not awaited: cancelling one branch of a cloned (tee'd) body settles only once the other branch is cancelled too.
      void reader.cancel().catch((err: unknown) => {
        console.warn("[runtime-wake] could not cancel an oversized body", err instanceof Error ? err.name : "unknown_error");
      });
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Reads a fetch Response without consuming it; only 503 bodies are read, and only up to the wake body limit. */
export async function readRuntimeWakeSignal(response: Response): Promise<RuntimeWakeSignal | null> {
  if (response.status !== 503 || typeof response.clone !== "function") return null;
  // UTF-8 is at most 4 bytes per character, so this byte cap never rejects a body within the character limit.
  const text = await readBoundedText(response, MAX_RUNTIME_WAKE_BODY_CHARS * 4);
  if (text === null) return null;
  return classifyRuntimeWakeText(response.status, response.headers?.get?.("retry-after"), text);
}

export function isIdempotentMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD" || normalized === "OPTIONS";
}

export interface RuntimeWakeRetryPolicyOptions {
  /** GET/HEAD/OPTIONS and WebSocket connection attempts. */
  idempotent: boolean;
  budgetMs?: number;
  now?: () => number;
  random?: () => number;
}

export interface RuntimeWakeRetryPolicy {
  /** Milliseconds to wait before the next attempt, or null to give up. */
  nextDelayMs(signal: RuntimeWakeSignal): number | null;
}

/**
 * One policy per logical request (or per WebSocket connect episode).
 * Waking retries until the budget runs out; busy and unavailable get one
 * retry each. Jitter only ever adds to Retry-After, never subtracts.
 */
export function createRuntimeWakeRetryPolicy(options: RuntimeWakeRetryPolicyOptions): RuntimeWakeRetryPolicy {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const budgetMs = options.budgetMs ?? RUNTIME_WAKE_BUDGET_MS;
  const startedAt = now();
  let busyRetries = 0;
  let unavailableRetries = 0;

  return {
    nextDelayMs(signal) {
      if (!options.idempotent && !signal.notForwarded) return null;
      if (signal.kind === "busy") {
        if (busyRetries >= 1) return null;
        busyRetries += 1;
      } else if (signal.kind === "unavailable") {
        if (unavailableRetries >= 1) return null;
        unavailableRetries += 1;
      }
      const jitter = Math.floor(random() * Math.min(MAX_JITTER_MS, signal.retryAfterMs / 4));
      const delay = signal.retryAfterMs + jitter;
      if (now() - startedAt + delay > budgetMs) return null;
      return delay;
    },
  };
}

/**
 * One signal that aborts when any input aborts. React Native has no
 * `AbortSignal.any`, so this links them by hand; `dispose` removes the
 * listeners once the caller no longer needs the combined signal.
 */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const abort = () => controller.abort();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of present) signal.removeEventListener("abort", abort);
    },
  };
}

function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/** setTimeout-based wait that rejects as soon as `signal` aborts. */
export function sleepForRuntimeWake(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Releases the unread original body of a wake response before retrying. */
async function discardBody(response: Response): Promise<void> {
  const body = response.body;
  if (!body || typeof body.cancel !== "function") return;
  try {
    await body.cancel();
  } catch (err: unknown) {
    console.warn("[runtime-wake] could not release a wake response body", err instanceof Error ? err.name : "unknown_error");
  }
}

export interface RuntimeWakeFetchOptions {
  method?: string;
  /** The caller's own abort signal; aborting ends the wait between attempts. */
  signal?: AbortSignal | null;
  budgetMs?: number;
  now?: () => number;
  random?: () => number;
  /** Called before each wait, with the signal that caused it. */
  onWaiting?: (signal: RuntimeWakeSignal) => void;
}

export interface RuntimeWakeFetchResult<T = Response> {
  response: T;
  /** Set when the last response was still a wake response and retrying stopped. */
  exhausted: RuntimeWakeSignal | null;
}

/**
 * Runs `attempt` (which must set its own per-attempt timeout) until the
 * response is not a retryable wake response. Returns the final response;
 * callers decide whether an exhausted wake becomes a thrown typed error
 * (CLI) or published state (Native Mobile).
 */
export function fetchWithRuntimeWake(
  attempt: () => Promise<Response>,
  options: RuntimeWakeFetchOptions = {},
): Promise<RuntimeWakeFetchResult> {
  return retryWithRuntimeWake(attempt, readRuntimeWakeSignal, options, discardBody);
}

/** Applies the same wake policy to transports that already return response text. */
export async function retryWithRuntimeWake<T>(
  attempt: () => Promise<T>,
  readSignal: (response: T) => RuntimeWakeSignal | null | Promise<RuntimeWakeSignal | null>,
  options: RuntimeWakeFetchOptions = {},
  discard?: (response: T) => Promise<void>,
): Promise<RuntimeWakeFetchResult<T>> {
  const policy = createRuntimeWakeRetryPolicy({
    idempotent: isIdempotentMethod(options.method),
    budgetMs: options.budgetMs,
    now: options.now,
    random: options.random,
  });
  for (;;) {
    const response = await attempt();
    const signal = await readSignal(response);
    if (!signal) return { response, exhausted: null };
    const delay = policy.nextDelayMs(signal);
    if (delay === null) return { response, exhausted: signal };
    if (discard) await discard(response);
    options.onWaiting?.(signal);
    await sleepForRuntimeWake(delay, options.signal);
  }
}
