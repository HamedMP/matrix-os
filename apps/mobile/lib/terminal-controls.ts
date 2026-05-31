import * as Clipboard from "expo-clipboard";
import type { TerminalControlKey } from "./terminal-state";

export const TERMINAL_CONTROL_KEYS: Array<{ label: string; key: TerminalControlKey }> = [
  { label: "Esc", key: "escape" },
  { label: "Tab", key: "tab" },
  { label: "Enter", key: "enter" },
  { label: "Ctrl-C", key: "ctrl-c" },
  { label: "Ctrl-D", key: "ctrl-d" },
  { label: "Ctrl-L", key: "ctrl-l" },
];

export async function sendTerminalClipboardPaste(onSend: (data: string) => void): Promise<void> {
  const text = await Clipboard.getStringAsync();
  if (text) onSend(text);
}
