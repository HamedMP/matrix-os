import type { TerminalControlKey } from "./terminal-state";

// Punctuation keys that have a control form, besides letters.
const CTRL_PUNCTUATION: Record<string, string> = {
  "@": "\x00",
  " ": "\x00",
  "[": "\x1b",
  "\\": "\x1c",
  "]": "\x1d",
  "^": "\x1e",
  "_": "\x1f",
  "?": "\x7f",
};

/**
 * The control key a sticky Ctrl turns one typed character into, or null when
 * the text has no control form (digits, several characters, escape sequences).
 */
export function applyTerminalCtrlModifier(data: string): string | null {
  if (data.length !== 1) return null;
  if (/^[a-z]$/i.test(data)) return String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96);
  return CTRL_PUNCTUATION[data] ?? null;
}

/** How far a finger moves on the key rows before it is a swipe and not a tap. */
export const ARROW_SWIPE_START_PX = 10;
// One arrow per step: about a character sideways, a little more up and down
// because the rows are short.
const ARROW_SWIPE_STEP_X_PX = 14;
const ARROW_SWIPE_STEP_Y_PX = 20;

export interface ArrowSwipeState {
  /** The axis the swipe started on; it keeps to it until the finger lifts. */
  axis: "x" | "y" | null;
  /** Arrows sent so far, positive for right or down. */
  sent: number;
}

/**
 * The arrow keys a swipe across the key rows has earned since the last call,
 * from the total distance the finger has moved since it touched down. Moving
 * back sends the opposite arrow, so the cursor follows the finger.
 */
export function arrowKeysForSwipe(
  state: ArrowSwipeState,
  dx: number,
  dy: number,
): { state: ArrowSwipeState; keys: TerminalControlKey[] } {
  let axis = state.axis;
  if (axis === null) {
    if (Math.abs(dx) < ARROW_SWIPE_START_PX && Math.abs(dy) < ARROW_SWIPE_START_PX) return { state, keys: [] };
    axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
  }
  const distance = axis === "x" ? dx : dy;
  const target = Math.trunc(distance / (axis === "x" ? ARROW_SWIPE_STEP_X_PX : ARROW_SWIPE_STEP_Y_PX));
  const forward: TerminalControlKey = axis === "x" ? "arrow-right" : "arrow-down";
  const back: TerminalControlKey = axis === "x" ? "arrow-left" : "arrow-up";
  const keys: TerminalControlKey[] = [];
  for (let sent = state.sent; sent < target; sent += 1) keys.push(forward);
  for (let sent = state.sent; sent > target; sent -= 1) keys.push(back);
  return { state: { axis, sent: target }, keys };
}
