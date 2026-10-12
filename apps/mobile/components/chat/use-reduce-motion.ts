import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/** Whether the person has asked the system to reduce motion. */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let current = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (current && enabled) setReduceMotion(true);
      })
      .catch((error: unknown) => {
        console.warn("[chat] Reduced-motion setting unavailable", error instanceof Error ? error.name : "UnknownError");
      });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}
