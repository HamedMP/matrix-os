const TERMINAL_DEBUG_ENABLED = process.env.TERMINAL_DEBUG !== "0";

export function logTerminalDebug(event: string, details: Record<string, unknown> = {}): void {
  if (!TERMINAL_DEBUG_ENABLED) {
    return;
  }
  console.info("[terminal-debug][gateway]", event, details);
}
