"use client";

import { TERMINAL_FONT_FAMILIES, useTerminalSettings, type ShellThemeId, type TerminalFontFamily, type TerminalThemeId } from "@/stores/terminal-settings";
import { TERMINAL_THEME_OPTIONS } from "./terminal-themes";

function mapLegacyThemeId(themeId: TerminalThemeId | undefined): ShellThemeId {
  if (themeId === "light" || themeId === "dark" || themeId === "matrix") return themeId;
  if (themeId === "one-light" || themeId === "solarized-light" || themeId === "github-light") return "light";
  return "dark";
}

export function TerminalSettingsPanel() {
  const themeId = useTerminalSettings((s) => s.themeId);
  const fontSize = useTerminalSettings((s) => s.fontSize);
  const fontFamily = useTerminalSettings((s) => s.fontFamily);
  const cursorBlink = useTerminalSettings((s) => s.cursorBlink);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const setFontSize = useTerminalSettings((s) => s.setFontSize);
  const setFontFamily = useTerminalSettings((s) => s.setFontFamily);
  const setCursorBlink = useTerminalSettings((s) => s.setCursorBlink);
  const selectedShellThemeId = mapLegacyThemeId(themeId);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="terminal-theme">
          Theme
        </label>
        <select
          id="terminal-theme"
          className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
          value={selectedShellThemeId}
          onChange={(e) => setThemeId(e.target.value as ShellThemeId)}
        >
          {TERMINAL_THEME_OPTIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="terminal-font-family">
          Font
        </label>
        <select
          id="terminal-font-family"
          className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
          value={fontFamily}
          onChange={(e) => setFontFamily(e.target.value as TerminalFontFamily)}
        >
          {TERMINAL_FONT_FAMILIES.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="terminal-font-size">
          Font size: {fontSize}px
        </label>
        <input
          id="terminal-font-size"
          type="range"
          min={9}
          max={24}
          step={1}
          value={fontSize}
          onChange={(e) => setFontSize(Number(e.target.value))}
          className="w-full"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={cursorBlink}
          onChange={(e) => setCursorBlink(e.target.checked)}
        />
        Blink cursor
      </label>
    </div>
  );
}
