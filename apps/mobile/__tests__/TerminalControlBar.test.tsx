import * as Clipboard from "expo-clipboard";
import {
  TERMINAL_CONTROL_KEYS,
  sendTerminalClipboardPaste,
} from "../lib/terminal-controls";
import { buildTerminalControlSequence } from "../lib/terminal-state";

describe("TerminalControlBar", () => {
  it("exposes the expected mobile terminal control keys", () => {
    expect(TERMINAL_CONTROL_KEYS.map((entry) => entry.label)).toEqual([
      "Esc",
      "Tab",
      "Enter",
      "Ctrl-C",
      "Ctrl-D",
      "Ctrl-L",
    ]);
    expect(TERMINAL_CONTROL_KEYS.map((entry) => buildTerminalControlSequence(entry.key))).toEqual([
      "\x1b",
      "\t",
      "\r",
      "\x03",
      "\x04",
      "\x0c",
    ]);
  });

  it("sends clipboard text through the terminal paste action", async () => {
    const onSend = jest.fn();
    jest.spyOn(Clipboard, "getStringAsync").mockResolvedValueOnce("copied text");

    await sendTerminalClipboardPaste(onSend);

    expect(onSend).toHaveBeenCalledWith("copied text");
  });
});
