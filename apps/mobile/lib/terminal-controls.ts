import * as Clipboard from "expo-clipboard";

export async function sendTerminalClipboardPaste(onSend: (data: string) => void): Promise<void> {
  const text = await Clipboard.getStringAsync();
  if (text) onSend(text);
}
