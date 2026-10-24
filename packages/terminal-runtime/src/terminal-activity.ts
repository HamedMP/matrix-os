export interface TerminalActivityScreen {
  ansi: string;
  viewport: string[];
  scrollback: string[];
  isInitial?: boolean;
}

/** An observer's initial frame is a replay, even if presentation changed while disconnected. */
export function isTerminalOutputActivity(previous: TerminalActivityScreen | undefined, next: TerminalActivityScreen): boolean {
  if (next.isInitial) return false;
  return !previous || previous.ansi !== next.ansi
    || !sameLines(previous.viewport, next.viewport)
    || !sameLines(previous.scrollback, next.scrollback);
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
