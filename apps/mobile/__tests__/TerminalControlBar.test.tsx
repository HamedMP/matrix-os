import * as Clipboard from "expo-clipboard";
import {
  TERMINAL_CONTROL_KEYS,
  sendTerminalClipboardPaste,
} from "../lib/terminal-controls";
import { buildTerminalControlSequence } from "../lib/terminal-state";

describe("TerminalControlBar", () => {
  it("exposes the ctrl-combo keys for the touch keyboard pad", () => {
    expect(TERMINAL_CONTROL_KEYS.map((entry) => entry.label)).toEqual([
      "^C",
      "^P",
      "^O",
      "^T",
      "^W",
      "^N",
      "^D",
      "^Z",
      "^L",
      "^R",
      "^S",
      "^Q",
      "^G",
      "^B",
      "^F",
      "^H",
      "^J",
      "^K",
      "^A",
      "^E",
      "^U",
    ]);
    expect(TERMINAL_CONTROL_KEYS.map((entry) => buildTerminalControlSequence(entry.key))).toEqual([
      "\x03",
      "\x10",
      "\x0f",
      "\x14",
      "\x17",
      "\x0e",
      "\x04",
      "\x1a",
      "\x0c",
      "\x12",
      "\x13",
      "\x11",
      "\x07",
      "\x02",
      "\x06",
      "\x08",
      "\x0a",
      "\x0b",
      "\x01",
      "\x05",
      "\x15",
    ]);
    // every pad key carries a human caption for discoverability
    expect(TERMINAL_CONTROL_KEYS.every((entry) => entry.caption.length > 0)).toBe(true);
  });

  it("sends clipboard text through the terminal paste action", async () => {
    const onSend = jest.fn();
    jest.spyOn(Clipboard, "getStringAsync").mockResolvedValueOnce("copied text");

    await sendTerminalClipboardPaste(onSend);

    expect(onSend).toHaveBeenCalledWith("copied text");
  });
});
