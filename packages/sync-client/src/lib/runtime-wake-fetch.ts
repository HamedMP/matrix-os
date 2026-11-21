import { fetchWithRuntimeWake, RuntimeWakeError } from "@matrix-os/contracts/runtime-wake";

/**
 * Gateway fetch that waits for a sleeping Matrix computer to wake (spec 2691,
 * ENG-520). Every attempt gets its own `AbortSignal.timeout(timeoutMs)`.
 * Mutating requests are retried only when the platform answered with
 * `runtimeState`, which it sends before proxying, so the request never
 * reached the computer. Throws `RuntimeWakeError` (code `runtime_waking`,
 * `runtime_busy`, or `runtime_unavailable`) once retrying stops.
 */
export async function fetchWithWakeRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const { response, exhausted } = await fetchWithRuntimeWake(
    () => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    { method: init.method },
  );
  if (exhausted) {
    throw new RuntimeWakeError(exhausted.kind);
  }
  return response;
}
