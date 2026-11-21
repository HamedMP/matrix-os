// The Terminal window keeps its most recently opened terminals mounted and
// attached, hidden behind the one on screen (spec 2701 layer 6): switching
// back to one shows it at once, with everything it printed meanwhile, instead
// of rebuilding xterm and attaching again. Past the limit the least recently
// shown is closed.

/**
 * How many terminals stay live. Local attachments share a budget of 8 slots
 * in the trusted core (`createAttachmentSlots`); this leaves room for an
 * attachment that is still closing while its replacement opens.
 */
export const TERMINAL_WINDOW_LIVE_TABS = 6;

export interface TerminalPane {
  /** Unique per pane; a new key is a new terminal view. */
  key: string;
  sessionName: string;
}

/**
 * The panes to keep after `current` was shown: `current` first, then the
 * others in the order they were last shown, without the ones `keep` rejects
 * (their terminal is gone), at most `max` in all.
 */
export function recentTerminalPanes<Pane extends TerminalPane>(
  previous: readonly Pane[],
  current: Pane | null,
  keep: (pane: Pane) => boolean,
  max = TERMINAL_WINDOW_LIVE_TABS,
): Pane[] {
  const rest = previous.filter((pane) => pane.key !== current?.key && keep(pane));
  return (current ? [current, ...rest] : rest).slice(0, Math.max(1, max));
}

export function samePanes(a: readonly TerminalPane[], b: readonly TerminalPane[]): boolean {
  return a.length === b.length && a.every((pane, index) => pane.key === b[index]!.key && pane.sessionName === b[index]!.sessionName);
}
