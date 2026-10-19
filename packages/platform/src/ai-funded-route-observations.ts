import type { FundedModelProbeResult } from "./ai-funded-model-probes.js";

// Keep time for the mandatory fresh owner-policy/ledger read after probing.
const FUNDING_RECHECK_MARGIN_MS = 1_500;

/** Each model owns its failure/deadline; health evidence is never authorization. */
export async function observeFundedModelRoutes(
  models: readonly string[],
  observe: (model: string, call: { signal: AbortSignal; deadlineAtMs: number }) => Promise<FundedModelProbeResult>,
  scope: { signal: AbortSignal; deadlineAtMs: number },
): Promise<Array<{ model: string; result: FundedModelProbeResult }>> {
  scope.signal.throwIfAborted();
  const deadlineAtMs = scope.deadlineAtMs - FUNDING_RECHECK_MARGIN_MS;
  const observations = await Promise.all(models.map(async model => {
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) return undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([scope.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => controller.abort(new Error("Model observation timed out")), remaining);
      });
      const result = await Promise.race([observe(model, { signal, deadlineAtMs }), deadline]);
      scope.signal.throwIfAborted();
      return { model, result };
    } catch (error: unknown) {
      scope.signal.throwIfAborted();
      console.warn("[funded-ai] Model observation unavailable:", error instanceof Error ? error.name : "UnknownError");
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }));
  scope.signal.throwIfAborted();
  const settled = observations.filter((value): value is NonNullable<typeof value> => value !== undefined);
  if (models.length > 0 && settled.length === 0) throw new Error("No model observation available");
  return settled;
}
