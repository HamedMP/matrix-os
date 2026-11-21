import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { syncPushRegistration } from "@/lib/push-registration-sync";
import { useActiveGateway } from "@/lib/queries/use-active-gateway";

/**
 * Registers this phone for push with the active computer once the computer is
 * known, and again each time the app comes back to the foreground. Renders
 * nothing; a failure is logged and the next foreground tries again.
 */
export function PushRegistrationSync() {
  const { gatewayUrl, session } = useActiveGateway();
  // One run at a time: a permission prompt sends the app inactive and back.
  const running = useRef(false);

  useEffect(() => {
    if (!gatewayUrl) return;

    async function sync() {
      if (running.current) return;
      running.current = true;
      try {
        const current = await session();
        if (!current) return;
        await syncPushRegistration({ clerkToken: current.token, gatewayUrl: current.gatewayUrl });
      } catch (error: unknown) {
        console.warn("[mobile] Push registration failed:", error instanceof Error ? error.message : "unknown");
      } finally {
        running.current = false;
      }
    }

    void sync();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => subscription.remove();
  }, [gatewayUrl, session]);

  return null;
}
