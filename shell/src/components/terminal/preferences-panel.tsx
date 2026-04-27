"use client";

import { useEffect } from "react";
import { useTerminalSettings, type TerminalCursorStyle, type TerminalFontFamily, type TerminalThemeId } from "@/stores/terminal-settings";
import { getGatewayUrl } from "@/lib/gateway";
import { TERMINAL_THEME_OPTIONS } from "./terminal-themes";

const FONT_OPTIONS: TerminalFontFamily[] = ["Berkeley Mono", "JetBrains Mono", "Fira Code"];
const CURSOR_OPTIONS: TerminalCursorStyle[] = ["block", "bar", "underline"];

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

  useEffect(() => {
    if (!sessionName || typeof fetch !== "function") {
      return;
    }
    let cancelled = false;
    void fetch(`${getGatewayUrl()}/api/sessions/${encodeURIComponent(sessionName)}/preferences`, {
      signal: AbortSignal.timeout(10_000),
    })
      .then((res) => res.ok ? res.json() : null)
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object" || !("preferences" in data)) {
          return;
        }
        const preferences = (data as { preferences: Partial<{
          themeId: TerminalThemeId;
          fontFamily: TerminalFontFamily;
          ligatures: boolean;
          cursorStyle: TerminalCursorStyle;
          smoothScroll: boolean;
        }> }).preferences;
        if (preferences.themeId) setThemeId(preferences.themeId);
        if (preferences.fontFamily) setFontFamily(preferences.fontFamily);
        if (typeof preferences.ligatures === "boolean") setLigatures(preferences.ligatures);
        if (preferences.cursorStyle) setCursorStyle(preferences.cursorStyle);
        if (typeof preferences.smoothScroll === "boolean") setSmoothScroll(preferences.smoothScroll);
      })
      .catch((err: unknown) => {
        console.warn("Failed to load terminal preferences:", err instanceof Error ? err.message : err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionName, setCursorStyle, setFontFamily, setLigatures, setSmoothScroll, setThemeId]);

  const persist = (patch: Partial<{
    themeId: TerminalThemeId;
    fontFamily: TerminalFontFamily;
    ligatures: boolean;
    cursorStyle: TerminalCursorStyle;
    smoothScroll: boolean;
  }>) => {
    if (!sessionName || typeof fetch !== "function") {
      return;
    }
    const state = useTerminalSettings.getState();
    void fetch(`${getGatewayUrl()}/api/sessions/${encodeURIComponent(sessionName)}/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        themeId: state.themeId,
        fontFamily: state.fontFamily,
        ligatures: state.ligatures,
        cursorStyle: state.cursorStyle,
        smoothScroll: state.smoothScroll,
        ...patch,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      console.warn("Failed to save terminal preferences:", err instanceof Error ? err.message : err);
    });
  };

  return (
    <div
      className="grid gap-3"
      style={{ minWidth: 240, padding: 12, color: "var(--foreground)" }}
    >
      <label className="grid gap-1 text-xs">
        <span style={{ color: "var(--muted-foreground)" }}>Theme</span>
        <select
          aria-label="Theme"
          value={themeId}
          onChange={(event) => {
            const next = event.target.value as TerminalThemeId;
            setThemeId(next);
            persist({ themeId: next });
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
          {FONT_OPTIONS.map((font) => <option key={font} value={font}>{font}</option>)}
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
