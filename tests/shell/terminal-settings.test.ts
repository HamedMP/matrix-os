import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("terminal settings defaults", () => {
  it("defaults new terminal settings to a dark terminal theme", async () => {
    const source = await readFile(new URL("../../shell/src/stores/terminal-settings.ts", import.meta.url), "utf8");

    expect(source).toContain('export const DEFAULT_TERMINAL_THEME_ID: TerminalThemeId = "one-dark";');
    expect(source).toContain("themeId: DEFAULT_TERMINAL_THEME_ID");
    expect(source).toContain('| "system"');
  });
});
