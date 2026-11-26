import { useEffect, useRef } from "react";
import { Alert, AppState } from "react-native";
import { useRouter } from "expo-router";

import { syncPushRegistration } from "@/lib/push-registration-sync";
import { useNotificationComputer } from "@/lib/use-notification-computer";

/**
 * Registers this phone for push with the active computer once the computer is
 * known, and again each time the app comes back to the foreground. Renders
 * nothing; a failure is logged and the next foreground tries again. Missing
 * consent history offers a scoped settings review, never an automatic opt-in.
 */
export function PushRegistrationSync() {
  const computer = useNotificationComputer();
  const router = useRouter();
  // One remembered scope, replaced when another computer needs a choice and
  // released on unmount. Repeated foreground events must not repeat the offer.
  const recoveryScope = useRef<string | null>(null);
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
        const result = await syncPushRegistration(current, () => active);
        if (active && result === "confirmation-required" && AppState.currentState === "active"
          && recoveryScope.current !== computer.key) {
          recoveryScope.current = computer.key;
          Alert.alert("Confirm phone notifications", [
            `Your notification choice for ${computer.name ?? "this computer"} needs confirmation.`,
            computer.address,
            "Review settings to enable alerts for this computer or keep them off.",
          ].filter(Boolean).join("\n"), [
            { text: "Not now", style: "cancel" },
            { text: "Review settings", onPress: () => { if (active) router.push("/settings-detail/notifications"); } },
          ]);
        }
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
  }, [computer, router]);

  return null;
}
