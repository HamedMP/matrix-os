import { describe, expect, it } from "vitest";
import {
  desktopShortcutLabel,
  systemTerminalLabel,
  taskPanelShortcutLabel,
} from "../../desktop/src/renderer/src/lib/platform-labels";

describe("desktop platform labels", () => {
  it.each([
    ["MacIntel", "K", "⌘K"],
    ["Win32", "K", "Ctrl+K"],
    ["Linux x86_64", "K", "Ctrl+K"],
  ])("formats %s shortcuts", (platform, keys, expected) => {
    expect(desktopShortcutLabel(keys, platform)).toBe(expected);
  });

  it.each([
    ["MacIntel", "⌘⌥1"],
    ["Win32", "Ctrl+Alt+1"],
    ["Linux x86_64", "Ctrl+Alt+1"],
  ])("formats %s Task panel shortcuts", (platform, expected) => {
    expect(taskPanelShortcutLabel(1, platform)).toBe(expected);
  });

  it.each([
    ["MacIntel", "Mac Terminal"],
    ["Win32", "Windows Terminal"],
    ["Linux x86_64", "system terminal"],
  ])("names the %s terminal", (platform, expected) => {
    expect(systemTerminalLabel(platform)).toBe(expected);
  });
});
