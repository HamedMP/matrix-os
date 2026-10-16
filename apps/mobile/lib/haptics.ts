import * as Haptics from "expo-haptics";

/** The system's warning tap, for something that did not work. Some devices have no haptics; that is logged, not shown. */
export function warningHaptic(): void {
  void Promise.resolve(
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  ).catch((error: unknown) => {
    console.warn("[mobile] warning haptic unavailable", error instanceof Error ? error.name : "unknown");
  });
}
