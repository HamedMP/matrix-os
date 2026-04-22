"use client";

import { useTerminalSettings, type TerminalThemeId } from "@/stores/terminal-settings";
import { TERMINAL_THEME_OPTIONS } from "./terminal-themes";

export function TerminalSettingsPanel() {
  const themeId = useTerminalSettings((s) => s.themeId);
  const fontSize = useTerminalSettings((s) => s.fontSize);
  const cursorBlink = useTerminalSettings((s) => s.cursorBlink);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const setFontSize = useTerminalSettings((s) => s.setFontSize);
  const setCursorBlink = useTerminalSettings((s) => s.setCursorBlink);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="terminal-theme">
          Theme
        </label>
        <select
          id="terminal-theme"
          className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm"
          value={themeId}
          onChange={(e) => setThemeId(e.target.value as TerminalThemeId)}
        >
          {TERMINAL_THEME_OPTIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
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
