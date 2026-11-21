import { useEffect } from "react";

import { RUNTIME_WAKE_MESSAGES } from "@matrix-os/contracts/runtime-wake";

import type { GatewayClient } from "@/lib/gateway-client";
import { TOAST_DURATION_MS, dismissToast, showToast } from "@/lib/toast";

type RuntimeWakeSource = Pick<GatewayClient, "onRuntimeWake">;

/**
 * Shows the gateway client's waking state (spec 2691, ENG-520) through the
 * shared toast host: "Waking your Matrix computer…" while a request has
 * waited 3 s or more for a wake, and the typed reason once retrying stops.
 * Holds no React state, so nothing updates after it unmounts.
 */
export function RuntimeWakeNotice({ client }: { client: RuntimeWakeSource | null }) {
  useEffect(() => {
    if (!client) return undefined;
    let noticeId: number | null = null;
    // Parallel requests fail together; say it once, with one haptic.
    let lastFailure: { code: string; at: number } | null = null;
    const hideNotice = () => {
      if (noticeId === null) return;
      dismissToast(noticeId);
      noticeId = null;
    };
    const unsubscribe = client.onRuntimeWake((event) => {
      if (event.type === "failed") {
        hideNotice();
        const now = Date.now();
        if (lastFailure?.code === event.code && now - lastFailure.at < TOAST_DURATION_MS) return;
        lastFailure = { code: event.code, at: now };
        showToast(RUNTIME_WAKE_MESSAGES[event.code], "error");
        return;
      }
      if (!event.visible) {
        hideNotice();
        return;
      }
      if (noticeId === null) {
        noticeId = showToast(RUNTIME_WAKE_MESSAGES.notice, "progress", { persistent: true });
      }
    });
    return () => {
      unsubscribe();
      hideNotice();
    };
  }, [client]);

  return null;
}
