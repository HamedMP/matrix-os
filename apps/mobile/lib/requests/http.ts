import {
  combineAbortSignals, fetchWithRuntimeWake, RUNTIME_WAKE_ATTEMPT_TIMEOUT_MS,
  RUNTIME_WAKE_ERROR_CODES, RUNTIME_WAKE_NOTICE_DELAY_MS,
  type RuntimeWakeFetchResult, type RuntimeWakeErrorCode,
} from "@matrix-os/contracts/runtime-lifecycle";
import { formatAuthorizationHeader } from "../authorization";

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

export type RequestToken = string | (() => Promise<string | null>);

interface AuthenticatedJsonRequest<T> {
  signal?: AbortSignal;
  url: string;
  token: RequestToken;
  schema: ResponseSchema<T>;
  errorMessage: string;
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface AuthenticatedRequest {
  signal?: AbortSignal;
  url: string;
  token: RequestToken;
  errorMessage: string;
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Non-2xx statuses that are an answer rather than a failure; `read` receives the response. */
  expectedStatuses?: readonly number[];
}

/** Safe display copy plus the status of an actual HTTP refusal, if received. */
export class AuthenticatedRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AuthenticatedRequestError";
  }
}

export async function resolveRequestToken(token: RequestToken, errorMessage: string): Promise<string> {
  const bearer = typeof token === "string" ? token : await token();
  if (!bearer?.trim()) throw new AuthenticatedRequestError(errorMessage);
  return bearer;
}

export function buildGatewayRequestUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function fetchAuthenticatedJson<T>({
  url,
  token,
  schema,
  errorMessage,
  timeoutMs = RUNTIME_WAKE_ATTEMPT_TIMEOUT_MS,
  method,
  headers,
  body,
  signal,
}: AuthenticatedJsonRequest<T>): Promise<T> {
  return fetchAuthenticatedResponse(
    { url, token, errorMessage, timeoutMs, method, headers, body, signal },
    async (response) => schema.parse(await response.json()),
  );
}

export async function fetchAuthenticatedResponse<T>(
  {
    url,
    token,
    errorMessage,
    timeoutMs = RUNTIME_WAKE_ATTEMPT_TIMEOUT_MS,
    method,
    headers,
    body,
    expectedStatuses, signal,
  }: AuthenticatedRequest,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  // Every attempt gets its own timeout; the caller's signal ends the whole wait.
  const attempts: Array<{ timeout: { signal: AbortSignal; cancel: () => void }; dispose: () => void }> = [];
  const attemptSignal = (): AbortSignal => {
    const timeout = createRequestTimeout(timeoutMs);
    const combined = signal ? combineAbortSignals(signal, timeout.signal) : null;
    attempts.push({ timeout, dispose: combined?.dispose ?? (() => undefined) });
    return combined?.signal ?? timeout.signal;
  };
  try {
    const response = await trackRuntimeWake((onWaiting) => fetchWithRuntimeWake(
      async () => {
        const bearer = await resolveRequestToken(token, errorMessage);
        return fetch(url, {
          method,
          headers: { Authorization: formatAuthorizationHeader(bearer)!, ...headers },
          body,
          signal: attemptSignal(),
        });
      },
      { method, signal, onWaiting },
    ));
    if (!response.ok && !expectedStatuses?.includes(response.status)) {
      throw new AuthenticatedRequestError(errorMessage, response.status);
    }
    return await read(response);
  } catch (error: unknown) {
    console.warn("[mobile] Request unavailable", error instanceof Error ? error.name : "UnknownError");
    // Only the typed error above proves an HTTP response was received. Network
    // and parsing errors stay uncertain, with no raw body or error text exposed.
    throw new AuthenticatedRequestError(errorMessage, error instanceof AuthenticatedRequestError ? error.status : undefined);
  } finally {
    for (const attempt of attempts) {
      attempt.dispose();
      attempt.timeout.cancel();
    }
  }
}

export function createRequestTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const timeout = (AbortSignal as { timeout?: (milliseconds: number) => AbortSignal }).timeout;
  if (typeof timeout === "function") {
    return { signal: timeout(timeoutMs), cancel: () => undefined };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

/**
 * Waking state of a sleeping Matrix computer (spec 2691, ENG-520), shared
 * with the UI alongside the connection state. `notice` turns on once a
 * request has waited 3 s for a wake and off when no request is waiting;
 * `failed` fires once when a request stops retrying.
 */
export type RuntimeWakeEvent =
  | { type: "notice"; visible: boolean }
  | { type: "failed"; code: RuntimeWakeErrorCode };

export type RuntimeWakeHandler = (event: RuntimeWakeEvent) => void;

/** Subscribers are a few UI hosts; past this the oldest is evicted so a leak cannot grow without bound. */
export const MAX_RUNTIME_WAKE_HANDLERS = 32;

/** Counts requests waiting on a wake and derives the notice from them. */
export class RuntimeWakeTracker {
  private handlers = new Set<RuntimeWakeHandler>();
  private waiting = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeVisible = false;

  get isNoticeVisible(): boolean {
    return this.noticeVisible;
  }

  subscribe(handler: RuntimeWakeHandler): () => void {
    this.handlers.delete(handler);
    this.handlers.add(handler);
    if (this.handlers.size > MAX_RUNTIME_WAKE_HANDLERS) {
      const oldest = this.handlers.values().next().value;
      if (oldest) this.handlers.delete(oldest);
      console.warn("[mobile] runtime wake subscriber evicted", "subscriber_cap");
    }
    // A host that resubscribes mid-wake (for example after a gateway switch) must still show the notice.
    if (this.noticeVisible) handler({ type: "notice", visible: true });
    return () => this.handlers.delete(handler);
  }

  begin(): void {
    this.waiting += 1;
    if (this.waiting !== 1 || this.noticeTimer) return;
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null;
      if (this.waiting === 0 || this.noticeVisible) return;
      this.noticeVisible = true;
      this.emit({ type: "notice", visible: true });
    }, RUNTIME_WAKE_NOTICE_DELAY_MS);
  }

  end(): void {
    this.waiting = Math.max(0, this.waiting - 1);
    if (this.waiting > 0) return;
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    if (!this.noticeVisible) return;
    this.noticeVisible = false;
    this.emit({ type: "notice", visible: false });
  }

  fail(code: RuntimeWakeErrorCode): void {
    this.emit({ type: "failed", code });
  }

  private emit(event: RuntimeWakeEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}

/**
 * The app's one wake tracker: GatewayClient requests and the shared request
 * helpers (`lib/requests/http`, used by Chat) report into it, so a single
 * notice covers every request waiting on the same wake.
 */
export const runtimeWakeTracker = new RuntimeWakeTracker();

/** Tracks one request across all of its attempts, including native file uploads. */
export async function trackRuntimeWake<T>(
  request: (onWaiting: () => void) => Promise<RuntimeWakeFetchResult<T>>,
): Promise<T> {
  let waiting = false;
  let result: RuntimeWakeFetchResult<T>;
  try {
    result = await request(() => {
      if (waiting) return;
      waiting = true;
      runtimeWakeTracker.begin();
    });
  } finally {
    if (waiting) runtimeWakeTracker.end();
  }
  if (result.exhausted) runtimeWakeTracker.fail(RUNTIME_WAKE_ERROR_CODES[result.exhausted.kind]);
  return result.response;
}
