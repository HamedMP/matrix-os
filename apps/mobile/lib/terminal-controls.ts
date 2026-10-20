import * as Clipboard from "expo-clipboard";

/** Sends the clipboard's text to the terminal. A clipboard that cannot be read is logged and nothing is sent. */
export async function sendTerminalClipboardPaste(onSend: (data: string) => void): Promise<void> {
  let text: string;
  try {
    text = await Clipboard.getStringAsync();
  } catch (error: unknown) {
    console.warn("[mobile] terminal paste unavailable", error instanceof Error ? error.name : "unknown");
    return;
  }
  if (text) onSend(text);
}
