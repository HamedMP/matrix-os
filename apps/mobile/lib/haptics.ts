import * as Haptics from "expo-haptics";

// The app's four touches of feedback. Each names a kind of moment rather than
// a strength, so the same moment feels the same everywhere.

// Some devices have no haptics. That is logged, never shown, and never stops
// the action the feedback belongs to.
function play(name: string, feedback: () => Promise<void>): void {
  const unavailable = (error: unknown) => {
    console.warn(`[mobile] ${name} haptic unavailable`, error instanceof Error ? error.name : "unknown");
  };
  try {
    void Promise.resolve(feedback()).catch(unavailable);
  } catch (error: unknown) {
    unavailable(error);
  }
}

/** A light tap for a press that starts something: sending, pulling to refresh, opening the side panel. */
export function tapHaptic(): void {
  play("tap", () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** The selection tick, for moving between choices: tabs, models, switches. */
export function selectHaptic(): void {
  play("select", () => Haptics.selectionAsync());
}

/** Something finished as asked: copied, renamed, deleted. */
export function successHaptic(): void {
  play("success", () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Something did not work, or is about to be removed for good. */
export function warningHaptic(): void {
  play("warning", () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}
