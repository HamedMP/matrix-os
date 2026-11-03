import { parseTerminalRefKey } from "./terminal-session-id";

export type TerminalInputSink = {
  readyState: number;
  send(data: string): void;
};

/**
 * The terminal tab socket closes on any input frame that fails its schema, so
 * keystrokes and paste must both go through here.
 */
export function sendTerminalInputFrame(
  ws: TerminalInputSink | null | undefined,
  terminalKey: string | null | undefined,
  data: string,
): boolean {
  const terminalRef = parseTerminalRefKey(terminalKey);
  if (!terminalRef || !ws || ws.readyState !== WebSocket.OPEN || data.length === 0) return false;
  ws.send(JSON.stringify({ type: "input", terminalRef, data }));
  return true;
}
