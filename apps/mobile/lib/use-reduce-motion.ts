import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

// One reading of the system setting, shared by every control that moves: a
// screen of pressable rows asks the system once, not once per row.
let reduceMotion = false;
let listeners: readonly (() => void)[] = [];
let subscription: { remove: () => void } | null = null;
// Names the current listening period, so an answer to an earlier one is dropped.
let period = 0;

function update(next: boolean) {
  if (next === reduceMotion) return;
  reduceMotion = next;
  for (const listener of listeners) listener();
}

function startListening() {
  period += 1;
  const asked = period;
  AccessibilityInfo.isReduceMotionEnabled()
    .then((enabled) => {
      if (asked === period && listeners.length > 0) update(enabled);
    })
    .catch((error: unknown) => {
      console.warn("[mobile] Reduced-motion setting unavailable", error instanceof Error ? error.name : "UnknownError");
    });
  subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", update);
}

function subscribe(listener: () => void) {
  listeners = [...listeners, listener];
  if (listeners.length === 1) startListening();
  return () => {
    listeners = listeners.filter((existing) => existing !== listener);
    if (listeners.length > 0) return;
    // Nobody is reading: stop listening and forget the answer, which may be
    // out of date by the time something reads it again.
    subscription?.remove();
    subscription = null;
    period += 1;
    reduceMotion = false;
  };
}

const currentSetting = () => reduceMotion;

/** Whether the person has asked the system to reduce motion. Motion until the system answers. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribe, currentSetting, currentSetting);
}
