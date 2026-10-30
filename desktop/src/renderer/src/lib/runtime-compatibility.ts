import { useCallback, useEffect, useState } from "react";
import { evaluateDesktopReleaseState, readRunningCommit } from "@matrix-os/contracts";
import type { ApiClient } from "./api";
import { invoke } from "./operator";

export const RUNTIME_RECONNECTED_EVENT = "matrix:runtime-reconnected";
const FOCUS_CHECK_COOLDOWN_MS = 15 * 60_000;

/** One bounded probe at a time; changing computers aborts and fences old results. */
export function useRuntimeCompatibility(api: ApiClient | null) {
  const [result, setResult] = useState<{ api: ApiClient | null; status: ReturnType<typeof evaluateDesktopReleaseState>["status"] | "checking"; protocol: ReturnType<typeof evaluateDesktopReleaseState>["protocol"] | null; noticeKey: string | null; checkId: number }>({ api, status: "checking", protocol: null, noticeKey: null, checkId: 0 });
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
        const [info, desktop] = await Promise.all([
          api.get<unknown>("/api/system/info", {
            maxBytes: 64 * 1024, signal: controller.signal, timeoutMs: 10_000,
          }),
          invoke("app:get-version", {}),
        ]);
        const { status, protocol } = evaluateDesktopReleaseState(info, desktop.source);
        if (active) setResult((previous) => ({ api, status, protocol, checkId: previous.checkId + 1,
          noticeKey: status === "unavailable" ? null : `${desktop.source?.commit ?? "unknown"}:${readRunningCommit(info) ?? "unknown"}:${protocol}` }));
      } catch (error: unknown) {
        if (active) {
          console.warn("[runtime-compatibility] check failed:", error instanceof Error ? error.name : "UnknownError");
          setResult((previous) => ({ api, status: "unavailable", protocol: null, noticeKey: null, checkId: previous.checkId + 1 }));
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
  return { status: result.api === api ? result.status : "checking",
    protocol: result.api === api ? result.protocol : null,
    noticeKey: result.api === api ? result.noticeKey : null,
    checkId: result.api === api ? result.checkId : 0, refresh };
}
