import { useEffect } from "react";
import { AppState } from "react-native";

import { syncPushRegistration } from "@/lib/push-registration-sync";
import { useNotificationComputer } from "@/lib/use-notification-computer";

/**
 * Registers this phone for push with the active computer once the computer is
 * known, and again each time the app comes back to the foreground. Renders
 * nothing; a failure is logged and the next foreground tries again.
 */
export function PushRegistrationSync() {
  const computer = useNotificationComputer();
  useEffect(() => {
    if (!computer.client) return;
    let active = true;
    // One run per computer; the shared push queue serializes remote changes.
    let running = false;

    async function sync() {
      if (!active || running) return;
      running = true;
      try {
        const current = await computer.session();
        if (!active || !current) return;
        await syncPushRegistration(current, () => active);
      } catch (error: unknown) {
        console.warn("[mobile] Push registration failed:", error instanceof Error ? error.message : "unknown");
      } finally {
        running = false;
      }
    }

    void sync();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });
    return () => { active = false; subscription.remove(); };
  }, [computer]);

  return null;
}
