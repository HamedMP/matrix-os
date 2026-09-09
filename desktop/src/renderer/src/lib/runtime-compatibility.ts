import { useCallback, useEffect, useState } from "react";
import { evaluateRuntimeCompatibility, type RuntimeCompatibilityStatus } from "@matrix-os/contracts";
import type { ApiClient } from "./api";

export const RUNTIME_RECONNECTED_EVENT = "matrix:runtime-reconnected";
const REFRESH_INTERVAL_MS = 60_000;

/** One bounded probe at a time; changing computers aborts and fences old results. */
export function useRuntimeCompatibility(api: ApiClient | null) {
  const [result, setResult] = useState<{ api: ApiClient | null; status: RuntimeCompatibilityStatus | "checking" }>({ api, status: "checking" });
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let checking = false;
    const controller = new AbortController();
    const check = async () => {
      if (checking || !active) return;
      checking = true;
      try {
        const info = await api.get<unknown>("/api/system/info", {
          maxBytes: 64 * 1024, signal: controller.signal, timeoutMs: 10_000,
        });
        if (active) setResult({ api, status: evaluateRuntimeCompatibility(info) });
      } catch (error: unknown) {
        if (active) {
          console.warn("[runtime-compatibility] check failed:", error instanceof Error ? error.name : "UnknownError");
          setResult({ api, status: "unavailable" });
        }
      } finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => void check(), REFRESH_INTERVAL_MS);
    const recheck = () => { void check(); };
    window.addEventListener("online", recheck);
    window.addEventListener("focus", recheck);
    window.addEventListener(RUNTIME_RECONNECTED_EVENT, recheck);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("online", recheck);
      window.removeEventListener("focus", recheck);
      window.removeEventListener(RUNTIME_RECONNECTED_EVENT, recheck);
    };
  }, [api, retry]);
  return { status: result.api === api ? result.status : "checking", refresh };
}
