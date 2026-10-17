// @vitest-environment jsdom
import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { observeTerminalData } from "../../packages/ui/src/terminal-input-provenance";

it("distinguishes identical protocol and user bytes using pinned xterm provenance", async () => {
  const terminal = new Terminal({ cols: 20, rows: 5 });
  const received: Array<[string, boolean]> = [];
  const subscription = observeTerminalData(terminal, (data, isUserInput) => received.push([data, isUserInput]));
  try {
    await new Promise<void>((resolve) => terminal.write("A\x1b[6n", resolve));
    const response = "\x1b[1;2R";
    expect(received).toEqual([[response, false]]);
    terminal.input(response);
    terminal.input("hello");
    expect(received.slice(1)).toEqual([[response, true], ["hello", true]]);
    subscription.dispose();
    terminal.input("after disposal");
    expect(received).toHaveLength(3);
  } finally { subscription.dispose(); terminal.dispose(); }
});

it("defaults unsupported emulators to activity-bearing input", () => {
  let emit!: (data: string) => void;
  const received: Array<[string, boolean]> = [];
  const subscription = observeTerminalData({ onData: (callback) => { emit = callback; return { dispose: () => undefined }; } }, (data, source) => received.push([data, source]));
  emit("legacy input");
  expect(received).toEqual([["legacy input", true]]);
  subscription.dispose();
});
