import {
  fetchWithRuntimeWake,
  RUNTIME_WAKE_MESSAGES,
  RUNTIME_WAKE_NOTICE_DELAY_MS,
  RuntimeWakeError,
} from "@matrix-os/contracts/runtime-wake";

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
  timeoutMs: number,
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
