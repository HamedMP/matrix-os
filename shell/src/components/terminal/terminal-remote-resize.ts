interface TerminalResizeSocket {
  readyState: number;
  send: (data: string) => void;
}

interface TerminalResizeTarget {
  cols: number;
  rows: number;
}

const WEBSOCKET_OPEN = 1;

export function sendTerminalResize(
  ws: TerminalResizeSocket | null,
  term: TerminalResizeTarget,
  allowRemoteResize: boolean,
  terminalKey?: string | null,
): boolean {
  if (!allowRemoteResize || !ws || ws.readyState !== WEBSOCKET_OPEN) {
    return false;
  }
  if (!Number.isFinite(term.cols) || !Number.isFinite(term.rows) || term.cols <= 0 || term.rows <= 0) {
    return false;
  }
  const terminalRef = parseTerminalRefKey(terminalKey);
  if (!terminalRef) return false;

  ws.send(JSON.stringify({
    type: "resize",
    terminalRef,
    mode: "soft",
    size: { cols: term.cols, rows: term.rows },
  }));
  return true;
}
import { parseTerminalRefKey } from "./terminal-session-id";
