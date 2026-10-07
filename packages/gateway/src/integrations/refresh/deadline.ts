import { IntegrationRefreshError } from "./contracts.js";
export async function readRefreshWithDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, timeoutMs = 30000): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal;
  if (signal.aborted) throw new IntegrationRefreshError("unavailable");
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let rejectAbort: () => void = () => {};
  try {
    const abort = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(new IntegrationRefreshError("unavailable"));
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
    return await Promise.race([operation(signal), abort]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", rejectAbort);
  }
}
