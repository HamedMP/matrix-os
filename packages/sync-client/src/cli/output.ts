import {
  classifyRuntimeWakeText,
  fetchWithRuntimeWake,
  MAX_RUNTIME_WAKE_BODY_CHARS,
  RUNTIME_WAKE_ATTEMPT_TIMEOUT_MS,
  RUNTIME_WAKE_MESSAGES,
  RUNTIME_WAKE_NOTICE_DELAY_MS,
  RuntimeWakeError,
  type RuntimeWakeSignal,
} from "@matrix-os/contracts/runtime-lifecycle";

export const CLI_OUTPUT_VERSION = 1;

const GENERIC_MESSAGES: Record<string, string> = {
  platform_unreachable: "Platform unreachable. Matrix CLI could not contact the Matrix OS platform.",
  gateway_unreachable: "Gateway unreachable. Matrix CLI could not contact your Matrix OS instance.",
  local_gateway_unavailable: "This computer's terminal token is unavailable. Restart Matrix OS, or pass --profile to use a signed-in profile.",
  request_timeout: "Request timed out. Try again or run `mos doctor`.",
  zellij_failed: "Shell backend unavailable. Your Matrix OS instance could not start a shell session.",
  unsupported_node: "Matrix CLI requires Node.js 20 or newer.",
  attach_failed: "Shell attach failed.",
  attach_timeout: "Shell attach timed out. Try again or run `mos doctor`.",
  login_failed: "Login failed. Run `mos login` to retry.",
  shell_backend_unavailable: "Shell backend unavailable. Run `mos doctor` for diagnostics.",
  unknown_command: "Request failed",
  unsupported_version: "Request failed",
  auth_expired: "Matrix CLI auth expired. Run `mos login` to refresh your session.",
  billing_required: "Choose a plan before running setup. Visit https://app.matrix-os.com/?plans=1.",
  not_authenticated: "Not signed in. Run `mos login` first.",
  retry_exhausted: "Setup has failed repeatedly. Contact support@matrix-os.com.",
  setup_failed: "Couldn't start setup. Please try again shortly.",
  setup_timeout: "Setup is taking longer than expected. Re-run `mos login` shortly to check.",
  payment_delayed: "Payment is taking longer than expected to confirm. Contact support@matrix-os.com if it persists.",
  terminal_agent_blocked: "The agent is waiting for a person. Read its screen first, or pass --force.",
  terminal_finished: "That terminal has finished.",
  not_found: "Terminal not found.",
  runtime_waking: RUNTIME_WAKE_MESSAGES.runtime_waking,
  runtime_busy: RUNTIME_WAKE_MESSAGES.runtime_busy,
  runtime_unavailable: RUNTIME_WAKE_MESSAGES.runtime_unavailable,
};

export function formatCliSuccess(data: Record<string, unknown>): string {
  return JSON.stringify({ v: CLI_OUTPUT_VERSION, ok: true, data });
}

export function formatCliErrorMessage(code: string, message?: string): string {
  return message ?? GENERIC_MESSAGES[code] ?? "Request failed";
}

export function formatCliError(
  code: string,
  message?: string,
  details?: Record<string, unknown>,
): string {
  return JSON.stringify({
    v: CLI_OUTPUT_VERSION,
    error: {
      code,
      message: formatCliErrorMessage(code, message),
      ...details,
    },
  });
}

export function cliError(code: string, message?: string): Error & { code: string } {
  return Object.assign(new Error(message ?? "Request failed"), { code });
}

export function isFetchTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "AbortError" || err.name === "TimeoutError");
}

export function isFetchNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

export function cliFetchError(
  err: unknown,
  codes: { timeout: string; network: string; fallback?: string },
): Error & { code: string } {
  if (isFetchTimeoutError(err)) {
    return cliError(codes.timeout);
  }
  if (isFetchNetworkError(err)) {
    return cliError(codes.network);
  }
  return cliError(codes.fallback ?? codes.network);
}

export function formatNdjsonEvent(
  type: string,
  data: Record<string, unknown>,
): string {
  return `${JSON.stringify({ v: CLI_OUTPUT_VERSION, type, data })}\n`;
}

/**
 * Gateway fetch that waits for a sleeping Matrix computer to wake (spec 2691,
 * ENG-520). Every attempt gets its own `AbortSignal.timeout(timeoutMs)`.
 * Mutating requests are retried only when the platform answered with
 * `runtimeState`, which it sends before proxying, so the request never
 * reached the computer. Once a wait passes 3 s, one notice line goes to
 * stderr (never stdout, so piped output stays clean). Throws
 * `RuntimeWakeError` (code `runtime_waking`, `runtime_busy`, or
 * `runtime_unavailable`) once retrying stops.
 */
export async function fetchWithWakeRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = RUNTIME_WAKE_ATTEMPT_TIMEOUT_MS,
): Promise<Response> {
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { response, exhausted } = await fetchWithRuntimeWake(
      () => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
      {
        method: init.method,
        onWaiting: () => {
          if (noticeTimer) return;
          noticeTimer = setTimeout(() => {
            process.stderr.write(`${RUNTIME_WAKE_MESSAGES.notice}\n`);
          }, RUNTIME_WAKE_NOTICE_DELAY_MS);
          noticeTimer.unref?.();
        },
      },
    );
    if (exhausted) {
      throw new RuntimeWakeError(exhausted.kind);
    }
    return response;
  } finally {
    clearTimeout(noticeTimer);
  }
}

/**
 * Refused websocket upgrades. The `ws` package emits `unexpected-response`
 * with the request and response when an upgrade is answered without a 101;
 * a 503 wake response there means the Matrix computer is still waking
 * (spec 2691, ENG-520).
 */

const UPGRADE_REFUSAL_READ_TIMEOUT_MS = 2_000;

interface UpgradeRefusal {
  status: number;
  retryAfter: string | null;
  body: string;
}

interface UpgradeRefusalMessage {
  statusCode?: unknown;
  headers?: Record<string, unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  resume?: () => unknown;
}

export function ignoreAbandonedSocketError(err: unknown): void {
  console.warn("[shell] abandoned attach socket reported an error", err instanceof Error ? err.name : "unknown_error");
}

function destroyUpgradeRequest(req: unknown): void {
  if (req && typeof req === "object" && typeof (req as { destroy?: unknown }).destroy === "function") {
    (req as { destroy: () => void }).destroy();
  }
}

/** Reads the status, Retry-After, and a bounded body of a refused websocket upgrade. */
function readUpgradeRefusal(res: unknown): Promise<UpgradeRefusal | null> {
  if (!res || typeof res !== "object") return Promise.resolve(null);
  const message = res as UpgradeRefusalMessage;
  const status = typeof message.statusCode === "number" ? message.statusCode : 0;
  const header = message.headers?.["retry-after"];
  const retryAfter = typeof header === "string" ? header : null;
  if (status !== 503 || typeof message.on !== "function") {
    message.resume?.();
    return Promise.resolve({ status, retryAfter, body: "" });
  }
  const on = message.on.bind(message);
  return new Promise((resolve) => {
    let body = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, retryAfter, body });
    };
    const timer = setTimeout(finish, UPGRADE_REFUSAL_READ_TIMEOUT_MS);
    timer.unref?.();
    on("data", (chunk: unknown) => {
      if (done) return;
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      // Past the cap it cannot be a wake response; stop reading.
      if (body.length > MAX_RUNTIME_WAKE_BODY_CHARS) finish();
    });
    on("end", finish);
    on("error", (err: unknown) => {
      console.warn("[shell] refused upgrade body unreadable", err instanceof Error ? err.name : "unknown_error");
      finish();
    });
  });
}

/** Reads a refused upgrade, releases its request, and returns its wake signal, if any. */
export async function readUpgradeRefusalWake(req: unknown, res: unknown): Promise<RuntimeWakeSignal | null> {
  const refusal = await readUpgradeRefusal(res);
  destroyUpgradeRequest(req);
  return refusal ? classifyRuntimeWakeText(refusal.status, refusal.retryAfter, refusal.body) : null;
}
