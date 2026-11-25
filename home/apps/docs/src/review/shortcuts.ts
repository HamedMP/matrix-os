/**
 * Keyboard shortcuts of the review panel. Matched on the physical key
 * (`KeyboardEvent.code`) so they work with any keyboard layout and with the
 * Option key on macOS, which changes `key`.
 */

export type ReviewCommand = "next" | "previous" | "accept" | "reject" | "comment";

export interface ShortcutEvent {
  code: string;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Alt+Shift with a letter. Ctrl and Cmd must be up so editor and system shortcuts keep working. */
const BINDINGS: Record<string, ReviewCommand> = {
  KeyN: "next",
  KeyP: "previous",
  KeyA: "accept",
  KeyR: "reject",
  KeyM: "comment",
};

/** Shortcut labels for tooltips and help, by command. */
export const REVIEW_SHORTCUTS: Readonly<Record<ReviewCommand, string[]>> = Object.freeze({
  next: ["Alt", "Shift", "N"],
  previous: ["Alt", "Shift", "P"],
  accept: ["Alt", "Shift", "A"],
  reject: ["Alt", "Shift", "R"],
  comment: ["Alt", "Shift", "M"],
});

export function matchReviewShortcut(event: ShortcutEvent): ReviewCommand | null {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null;
  return BINDINGS[event.code] ?? null;
}
