import { describe, expect, it } from "vitest";
import {
  desktopShortcutLabel,
  systemTerminalLabel,
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
    ["MacIntel", "Mac Terminal"],
    ["Win32", "Windows Terminal"],
    ["Linux x86_64", "system terminal"],
  ])("names the %s terminal", (platform, expected) => {
    expect(systemTerminalLabel(platform)).toBe(expected);
  });
});
