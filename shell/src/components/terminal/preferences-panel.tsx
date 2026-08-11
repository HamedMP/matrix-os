"use client";

import { TERMINAL_FONT_FAMILIES, useTerminalSettings, type ShellThemeId, type TerminalCursorStyle, type TerminalFontFamily, type TerminalThemeId } from "@/stores/terminal-settings";
import { TERMINAL_THEME_OPTIONS } from "./terminal-themes";

const CURSOR_OPTIONS: TerminalCursorStyle[] = ["block", "bar", "underline"];

function mapLegacyThemeId(themeId: TerminalThemeId | undefined): ShellThemeId | null {
  if (!themeId) return null;
  if (themeId === "dark" || themeId === "light" || themeId === "matrix") return themeId;
  if (themeId === "system") return null;
  if (themeId === "one-light" || themeId === "solarized-light" || themeId === "github-light") return "light";
  if (themeId === "one-dark" || themeId === "catppuccin-mocha" || themeId === "dracula" || themeId === "solarized-dark" || themeId === "nord" || themeId === "github-dark") return "dark";
  return "dark";
}

interface TerminalPreferencesPanelProps {
  sessionName?: string | null;
}

export function TerminalPreferencesPanel({ sessionName }: TerminalPreferencesPanelProps = {}) {
  const themeId = useTerminalSettings((s) => s.themeId);
  const fontFamily = useTerminalSettings((s) => s.fontFamily);
  const ligatures = useTerminalSettings((s) => s.ligatures);
  const cursorStyle = useTerminalSettings((s) => s.cursorStyle);
  const smoothScroll = useTerminalSettings((s) => s.smoothScroll);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const setFontFamily = useTerminalSettings((s) => s.setFontFamily);
  const setLigatures = useTerminalSettings((s) => s.setLigatures);
  const setCursorStyle = useTerminalSettings((s) => s.setCursorStyle);
  const setSmoothScroll = useTerminalSettings((s) => s.setSmoothScroll);
  const selectedShellThemeId = mapLegacyThemeId(themeId) ?? "dark";

  // Terminal chrome preferences are device-local Zustand state. Only the
  // global shell theme uses the gateway-wide terminal preferences endpoint;
  // a tab ref is never used to revive the retired per-session routes.
  void sessionName;
  const persist = (_patch: unknown) => undefined;

  return (
    <div
      className="grid gap-3"
      style={{ minWidth: 240, padding: 12, color: "var(--foreground)" }}
    >
      <label className="grid gap-1 text-xs">
        <span style={{ color: "var(--muted-foreground)" }}>Theme</span>
        <select
          aria-label="Theme"
          value={selectedShellThemeId}
          onChange={(event) => {
            const next = event.target.value as ShellThemeId;
            setThemeId(next);
            persist({ shellThemeId: next });
          }}
        >
          {TERMINAL_THEME_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </label>

      <label className="grid gap-1 text-xs">
        <span style={{ color: "var(--muted-foreground)" }}>Font</span>
        <select
          aria-label="Font"
          value={fontFamily}
          onChange={(event) => {
            const next = event.target.value as TerminalFontFamily;
            setFontFamily(next);
            persist({ fontFamily: next });
          }}
        >
          {TERMINAL_FONT_FAMILIES.map((font) => <option key={font} value={font}>{font}</option>)}
        </select>
      </label>

      <label className="grid gap-1 text-xs">
        <span style={{ color: "var(--muted-foreground)" }}>Cursor</span>
        <select
          aria-label="Cursor"
          value={cursorStyle}
          onChange={(event) => {
            const next = event.target.value as TerminalCursorStyle;
            setCursorStyle(next);
            persist({ cursorStyle: next });
          }}
        >
          {CURSOR_OPTIONS.map((cursor) => <option key={cursor} value={cursor}>{cursor}</option>)}
        </select>
      </label>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span>Ligatures</span>
        <input
          aria-label="Ligatures"
          type="checkbox"
          checked={ligatures}
          onChange={(event) => {
            setLigatures(event.target.checked);
            persist({ ligatures: event.target.checked });
          }}
        />
      </label>

      <label className="flex items-center justify-between gap-3 text-xs">
        <span>Smooth scroll</span>
        <input
          aria-label="Smooth scroll"
          type="checkbox"
          checked={smoothScroll}
          onChange={(event) => {
            setSmoothScroll(event.target.checked);
            persist({ smoothScroll: event.target.checked });
          }}
        />
      </label>
    </div>
  );
}
