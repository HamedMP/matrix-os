"use client";

import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { DEFAULT_THEME, saveTheme, useTheme, type Theme } from "@/hooks/useTheme";
import {
  saveDesktopConfigPatch,
  type DesktopConfig,
  type DesktopConfigPatch,
} from "@/hooks/useDesktopConfig";
import {
  getPreset,
  MACOS_GLASS_THEME,
  WIN11_THEME,
  WINXP_THEME,
} from "@/lib/theme-presets";
import { useOsSessionStore } from "@/components/os-session/os-session-store";
import { isBootDesign } from "@/components/os-session/os-session-utils";

/* ── Design options ────────────────────────────── */

type DesignStyle = NonNullable<Theme["style"]>;

const DEFAULT_FLAT_THEME: Theme = {
  ...(getPreset("default") ?? DEFAULT_THEME),
  style: "flat",
};

interface DesignOption {
  id: DesignStyle;
  label: string;
  theme: Theme;
}

const DESIGN_OPTIONS: DesignOption[] = [
  { id: "flat", label: "Default", theme: DEFAULT_FLAT_THEME },
  { id: "macos-glass", label: "macOS 27", theme: MACOS_GLASS_THEME },
  { id: "winxp", label: "Windows XP", theme: WINXP_THEME },
  { id: "win11", label: "Windows 11", theme: WIN11_THEME },
];

/* ── Per-design desktop defaults ───────────────── */

/** Bundled wallpapers applied when a design is picked. Designs missing from
    this map leave the user's background (and dock) untouched. */
const DESIGN_BACKGROUNDS: Partial<Record<DesignStyle, DesktopConfig["background"]>> = {
  // Product default: macOS deliberately starts on the first image shown in
  // Appearance. macos-light.svg remains available as a user-selectable image.
  "macos-glass": { type: "wallpaper", name: "moraine-lake.jpg" },
  winxp: { type: "wallpaper", name: "xp-bliss.svg" },
  win11: { type: "wallpaper", name: "win11-bloom.svg" },
};

/** Designs that also move the dock to match their OS's real placement. */
const DESIGN_DOCK_POSITIONS: Partial<Record<DesignStyle, DesktopConfig["dock"]["position"]>> = {
  "macos-glass": "bottom",
};

/* ── Pure-CSS preview swatches ─────────────────── */

function PreviewFrame({ children, style }: { children: React.ReactNode; style: React.CSSProperties }) {
  return (
    <div
      className="h-16 w-full overflow-hidden rounded-md border border-border/60"
      style={style}
      aria-hidden
    >
      {children}
    </div>
  );
}

function DefaultPreview() {
  return (
    <PreviewFrame style={{ background: "#FAFAF9" }}>
      <div
        style={{
          margin: "10px auto 0",
          width: "72%",
          height: "100%",
          background: "#FCFCF8",
          border: "1px solid #D8D6C7",
          borderRadius: 6,
          padding: 6,
        }}
      >
        <div style={{ height: 6, width: "42%", background: "#434E3F", borderRadius: 2, opacity: 0.85 }} />
        <div style={{ height: 4, width: "64%", background: "#E1E1D0", borderRadius: 2, marginTop: 5 }} />
      </div>
    </PreviewFrame>
  );
}

function RetroPreview() {
  return (
    <PreviewFrame style={{ background: "#D4D4D4", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width: "72%",
          height: "72%",
          background: "#D4D4D4",
          borderRadius: 8,
          boxShadow: "3px 3px 6px rgba(163, 163, 163, 0.5), -3px -3px 6px rgba(255, 255, 255, 0.7)",
          padding: 6,
        }}
      >
        <div style={{ height: 5, width: "48%", background: "#008080", borderRadius: 3 }} />
        <div
          style={{
            height: 4,
            width: "66%",
            background: "#D4D4D4",
            borderRadius: 2,
            marginTop: 5,
            boxShadow: "inset 1px 1px 3px rgba(163, 163, 163, 0.5), inset -1px -1px 3px rgba(255, 255, 255, 0.7)",
          }}
        />
      </div>
    </PreviewFrame>
  );
}

const GLASS_PANEL_STYLE: React.CSSProperties = {
  margin: "8px auto 0",
  width: "74%",
  height: "100%",
  background: "rgba(255, 255, 255, 0.55)",
  border: "1px solid rgba(0, 0, 0, 0.08)",
  borderRadius: 8,
  backdropFilter: "blur(6px)",
  padding: 5,
};

function trafficDot(color: string): React.CSSProperties {
  return { width: 5, height: 5, borderRadius: "50%", background: color };
}

function MacosGlassPreview() {
  return (
    <PreviewFrame style={{ background: "linear-gradient(135deg, #A8C0E8 0%, #C9BFE3 55%, #EFC7D3 100%)" }}>
      <div style={GLASS_PANEL_STYLE}>
        <div style={{ display: "flex", gap: 3 }}>
          <span style={trafficDot("#FF5F57")} />
          <span style={trafficDot("#FEBC2E")} />
          <span style={trafficDot("#28C840")} />
        </div>
        <div style={{ height: 4, width: "55%", background: "rgba(0, 0, 0, 0.3)", borderRadius: 2, marginTop: 6 }} />
      </div>
    </PreviewFrame>
  );
}

function WinXpPreview() {
  return (
    <PreviewFrame style={{ background: "#ECE9D8" }}>
      <div
        style={{
          margin: "8px auto 0",
          width: "76%",
          height: "100%",
          background: "#FFFFFF",
          border: "1px solid #7F9DB9",
          borderRadius: "3px 3px 0 0",
          overflow: "hidden",
        }}
      >
        <div style={{ height: 10, background: "linear-gradient(180deg, #3A93FF 0%, #0058E6 45%, #0044B8 100%)" }} />
        <div style={{ height: 4, width: "58%", background: "#ECE9D8", border: "1px solid #D6D2C0", margin: "5px 6px 0" }} />
      </div>
    </PreviewFrame>
  );
}

function Win11Preview() {
  return (
    <PreviewFrame style={{ background: "#F3F3F3", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        style={{
          width: "72%",
          height: "74%",
          background: "rgba(250, 250, 250, 0.92)",
          border: "1px solid #D6D6D6",
          borderRadius: 8,
          boxShadow: "0 4px 14px rgba(0, 0, 0, 0.12)",
          padding: 6,
        }}
      >
        <div style={{ height: 5, width: "46%", background: "#0067C0", borderRadius: 3 }} />
        <div style={{ height: 4, width: "64%", background: "#EAEAEA", borderRadius: 2, marginTop: 5 }} />
      </div>
    </PreviewFrame>
  );
}

const PREVIEWS: Record<DesignStyle, () => React.ReactElement> = {
  flat: DefaultPreview,
  neumorphic: RetroPreview,
  "macos-glass": MacosGlassPreview,
  winxp: WinXpPreview,
  win11: Win11Preview,
};

/* ── Component ─────────────────────────────────── */

export function DesignPicker() {
  const theme = useTheme();
  const activeId: DesignStyle = theme?.style ?? "flat";
  const [pendingId, setPendingId] = useState<DesignStyle | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(option: DesignOption) {
    if (pendingId) return;
    setError(null);
    setPendingId(option.id);
    try {
      // Spread the preset so colors/fonts/radius/style all persist as the saved theme.
      await saveTheme({ ...option.theme });
    } catch (err) {
      console.warn("[appearance] Failed to save design theme:", err);
      setError("Couldn't apply that design. Please try again.");
      // No `finally` — React Compiler cannot lower TryStatement with a finalizer.
      setPendingId(null);
      return;
    }
    // The theme is saved; apply the design's bundled wallpaper (and dock
    // placement) as the second step. A failure here is surfaced but does not
    // roll back the theme.
    const background = DESIGN_BACKGROUNDS[option.id];
    if (background) {
      try {
        const dockPosition = DESIGN_DOCK_POSITIONS[option.id];
        const patch: DesktopConfigPatch = { background };
        if (dockPosition) {
          patch.dock = { position: dockPosition };
        }
        await saveDesktopConfigPatch(patch);
      } catch (err) {
        console.warn("[appearance] Failed to apply design desktop defaults:", err);
        setError(
          DESIGN_DOCK_POSITIONS[option.id]
            ? "Design applied, but its wallpaper or Dock position couldn't be updated. Try those settings again below."
            : "Design applied, but its wallpaper couldn't be updated. Try choosing it again below.",
        );
      }
    }
    if (option.id !== activeId && isBootDesign(option.id)) {
      useOsSessionStore.getState().beginBoot(option.id);
    }
    // No `finally` — React Compiler cannot lower TryStatement with a finalizer.
    setPendingId(null);
  }

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Design</h3>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label="Design system">
        {DESIGN_OPTIONS.map((option) => {
          const isActive = activeId === option.id;
          const Preview = PREVIEWS[option.id];
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={isActive}
              disabled={pendingId !== null}
              onClick={() => handleSelect(option)}
              className={`rounded-lg border-2 p-2 text-left transition-all ${
                isActive
                  ? "border-primary ring-1 ring-primary/30"
                  : "border-border hover:border-primary/40"
              } ${pendingId === option.id ? "opacity-70" : ""}`}
            >
              <Preview />
              <div className="mt-2 flex items-center justify-between gap-1">
                <span className="text-xs font-medium">{option.label}</span>
                {isActive && <CheckIcon className="size-3.5 text-primary" />}
              </div>
            </button>
          );
        })}
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
