import * as Clipboard from "expo-clipboard";
import type { TerminalControlKey } from "./terminal-state";

// Ctrl-combo pad shown in the touch keyboard. label is the chip glyph,
// caption is the human-readable action for discoverability.
export const TERMINAL_CONTROL_KEYS: Array<{ label: string; caption: string; key: TerminalControlKey }> = [
  { label: "^C", caption: "interrupt", key: "ctrl-c" },
  { label: "^D", caption: "eof", key: "ctrl-d" },
  { label: "^Z", caption: "suspend", key: "ctrl-z" },
  { label: "^L", caption: "clear", key: "ctrl-l" },
  { label: "^R", caption: "search", key: "ctrl-r" },
  { label: "^A", caption: "line start", key: "ctrl-a" },
  { label: "^E", caption: "line end", key: "ctrl-e" },
  { label: "^U", caption: "clear line", key: "ctrl-u" },
  { label: "^K", caption: "kill", key: "ctrl-k" },
  { label: "^W", caption: "del word", key: "ctrl-w" },
];

// Special keys shown on the keyboard's home row.
export const TERMINAL_SPECIAL_KEYS: Array<{ label: string; key: TerminalControlKey }> = [
  { label: "esc", key: "escape" },
  { label: "tab", key: "tab" },
  { label: "⏎", key: "enter" },
];

// Literal characters that are awkward to reach on the iOS keyboard but common in
// shell usage. These send the raw character rather than a control sequence.
export const TERMINAL_SYMBOL_KEYS: Array<{ label: string; value: string }> = [
  { label: "|", value: "|" },
  { label: "~", value: "~" },
  { label: "/", value: "/" },
  { label: "-", value: "-" },
  { label: "_", value: "_" },
  { label: "*", value: "*" },
  { label: "$", value: "$" },
];

export const TERMINAL_ARROW_KEYS: Array<{ label: string; key: TerminalControlKey }> = [
  { label: "←", key: "arrow-left" },
  { label: "↑", key: "arrow-up" },
  { label: "↓", key: "arrow-down" },
  { label: "→", key: "arrow-right" },
];

export async function sendTerminalClipboardPaste(onSend: (data: string) => void): Promise<void> {
  const text = await Clipboard.getStringAsync();
  if (text) onSend(text);
}
