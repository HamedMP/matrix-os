import { useCallback, useEffect, useState } from "react";
import { evaluateRuntimeCompatibility, type RuntimeCompatibilityStatus } from "@matrix-os/contracts";
import type { ApiClient } from "./api";

export const RUNTIME_RECONNECTED_EVENT = "matrix:runtime-reconnected";
const FOCUS_CHECK_COOLDOWN_MS = 15 * 60_000;

/** One bounded probe at a time; changing computers aborts and fences old results. */
export function useRuntimeCompatibility(api: ApiClient | null) {
  const [result, setResult] = useState<{ api: ApiClient | null; status: RuntimeCompatibilityStatus | "checking" }>({ api, status: "checking" });
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    if (!api) return;
    let active = true;
    let checking = false;
    let lastCheckedAt = Number.NEGATIVE_INFINITY;
    const controller = new AbortController();
    const check = async (force = true) => {
      if (checking || !active) return;
      if (!force && Date.now() - lastCheckedAt < FOCUS_CHECK_COOLDOWN_MS) return;
      lastCheckedAt = Date.now();
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
    const recheck = () => { void check(); };
    const recheckOnFocus = () => { void check(false); };
    window.addEventListener("online", recheck);
    window.addEventListener("focus", recheckOnFocus);
    window.addEventListener(RUNTIME_RECONNECTED_EVENT, recheck);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("online", recheck);
      window.removeEventListener("focus", recheckOnFocus);
      window.removeEventListener(RUNTIME_RECONNECTED_EVENT, recheck);
    };
  }, [api, retry]);
  return { status: result.api === api ? result.status : "checking", refresh };
}
