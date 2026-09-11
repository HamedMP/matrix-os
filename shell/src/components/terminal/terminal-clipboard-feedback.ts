export interface TerminalClipboardFeedback {
  sequence: number;
  message: string;
}

export function terminalClipboardFailureFeedback(
  current: TerminalClipboardFeedback | null,
  sequence: number,
  message: string,
): TerminalClipboardFeedback {
  return current && current.sequence > sequence ? current : { sequence, message };
}

export function terminalClipboardSuccessFeedback(
  current: TerminalClipboardFeedback | null,
  sequence: number,
): TerminalClipboardFeedback | null {
  // Copy and paste execute independently. A success may clear feedback that
  // was already visible when the operation began, but it must not silence a
  // still-running operation that reports its own failure afterward.
  return current && current.sequence > sequence ? current : null;
}
