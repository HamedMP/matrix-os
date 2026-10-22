import { useCallback, useEffect, useState } from "react";
import { evaluateDesktopReleaseState, RuntimeCompatibilitySchema, DESKTOP_PROTOCOL_VERSION } from "@matrix-os/contracts";
import type { ApiClient } from "./api";

export const RUNTIME_RECONNECTED_EVENT = "matrix:runtime-reconnected";
const FOCUS_CHECK_COOLDOWN_MS = 15 * 60_000;

/** One bounded probe at a time; changing computers aborts and fences old results. */
export function useRuntimeCompatibility(api: ApiClient | null, runtimeSlot = "primary") {
  const [result, setResult] = useState<{ api: ApiClient | null; runtimeSlot: string; status: ReturnType<typeof evaluateDesktopReleaseState>["status"] | "checking"; noticeKey: string | null }>({ api, runtimeSlot, status: "checking", noticeKey: null });
  const [retry, setRetry] = useState(0);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  useEffect(() => {
    if (!api) return;
    const boundApi = api.forRuntime(runtimeSlot);
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
        const info = await boundApi.get<unknown>("/api/system/info", {
          maxBytes: 64 * 1024, signal: controller.signal, timeoutMs: 10_000,
        });
        const { status } = evaluateDesktopReleaseState(info, null);
        const handshake = RuntimeCompatibilitySchema.safeParse(
          info && typeof info === "object" && "runtimeCompatibility" in info ? info.runtimeCompatibility : undefined);
        if (active) setResult({ api, runtimeSlot, status,
          noticeKey: handshake.success ? `${DESKTOP_PROTOCOL_VERSION}:${handshake.data.minDesktopProtocol}:${handshake.data.maxDesktopProtocol}` : null });
      } catch (error: unknown) {
        if (active) {
          console.warn("[runtime-compatibility] check failed:", error instanceof Error ? error.name : "UnknownError");
          setResult({ api, runtimeSlot, status: "unavailable", noticeKey: null });
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
  }, [api, runtimeSlot, retry]);
  return { status: result.api === api && result.runtimeSlot === runtimeSlot ? result.status : "checking",
    noticeKey: result.api === api && result.runtimeSlot === runtimeSlot ? result.noticeKey : null, refresh };
}
