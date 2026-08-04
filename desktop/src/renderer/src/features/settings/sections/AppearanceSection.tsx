import { Check, Minus, Plus } from "lucide-react";
import { Button, IconButton } from "../../../design/primitives";
import { getThemeVariant, unifiedThemes } from "../../../design/themes";
import { resolveThemeMode, type ThemeMode } from "../../../design/themes/apply";
import { MAX_ZOOM, MIN_ZOOM, useAppearance, ZOOM_STEP } from "../../../stores/appearance";
import { Card, SectionHeader } from "./section-kit";

function ThemeSwatch({ themeId, mode, selected, onSelect, onArrowKey }: {
  themeId: string;
  mode: ThemeMode;
  selected: boolean;
  onSelect: (themeId: string) => void;
  onArrowKey: (fromThemeId: string, direction: 1 | -1) => void;
}) {
  const theme = unifiedThemes.find((candidate) => candidate.id === themeId);
  if (!theme) return null;
  const { chrome, editor } = getThemeVariant(themeId, resolveThemeMode(mode));
  const variants = [theme.dark ? "dark" : null, theme.light ? "light" : null]
    .filter(Boolean)
    .join(" + ");

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`Use ${theme.name} theme`}
      // Roving tabindex: the group is one tab stop; arrows move within it.
      tabIndex={selected ? 0 : -1}
      className="flex flex-col gap-2 rounded-lg border p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{
        borderColor: selected ? "var(--accent)" : "var(--border-subtle)",
        background: "var(--bg-surface)",
      }}
      onClick={() => onSelect(themeId)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          onArrowKey(themeId, 1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          onArrowKey(themeId, -1);
        }
      }}
    >
      <span
        aria-hidden="true"
        className="flex h-14 w-full items-center justify-center gap-1 overflow-hidden rounded-md border"
        style={{ background: chrome.background, borderColor: chrome.border }}
      >
        <span className="h-6 w-6 rounded" style={{ background: chrome.card }} />
        <span className="h-6 w-1.5 rounded-full" style={{ background: chrome.ring }} />
        <span className="h-6 w-1.5 rounded-full" style={{ background: editor.string }} />
        <span className="h-6 w-1.5 rounded-full" style={{ background: editor.keyword }} />
        <span className="h-6 w-1.5 rounded-full" style={{ background: chrome.destructive }} />
      </span>
      <span className="flex items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium" style={{ color: "var(--text-primary)" }}>{theme.name}</span>
          <span className="block text-[10px]" style={{ color: "var(--text-tertiary)" }}>{variants}</span>
        </span>
        {selected ? <Check size={13} className="shrink-0" style={{ color: "var(--accent)" }} aria-hidden="true" /> : null}
      </span>
    </button>
  );
}

export default function AppearanceSection() {
  const mode = useAppearance((s) => s.mode);
  const themeId = useAppearance((s) => s.themeId);
  const zoom = useAppearance((s) => s.zoom);
  const setMode = useAppearance((s) => s.setMode);
  const setThemeId = useAppearance((s) => s.setThemeId);
  const setZoom = useAppearance((s) => s.setZoom);

  // WAI-ARIA radio group: arrows select the adjacent swatch (wrapping) and
  // move focus to it.
  const moveSelection = (fromThemeId: string, direction: 1 | -1) => {
    const index = unifiedThemes.findIndex((theme) => theme.id === fromThemeId);
    if (index === -1) return;
    const next = unifiedThemes[(index + direction + unifiedThemes.length) % unifiedThemes.length];
    if (!next) return;
    setThemeId(next.id);
    const target = document.querySelector<HTMLButtonElement>(`[role="radio"][aria-label="Use ${next.name} theme"]`);
    target?.focus();
  };

  return (
    <>
      <SectionHeader title="Appearance" description="How Matrix OS looks on this machine." />
      <Card>
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Mode</span>
        <div className="flex gap-2">
          {(["light", "dark", "system"] as const).map((option) => (
            <Button key={option} variant={mode === option ? "primary" : "subtle"} onClick={() => setMode(option)}>
              {option[0]?.toUpperCase()}{option.slice(1)}
            </Button>
          ))}
        </div>
      </Card>
      <Card>
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Zoom</span>
        <div className="flex items-center gap-2">
          <IconButton
            label="Zoom out (⌘-)"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom(zoom - ZOOM_STEP)}
          >
            <Minus size={14} aria-hidden="true" />
          </IconButton>
          <span
            className="w-12 text-center text-sm tabular-nums"
            style={{ color: "var(--text-primary)" }}
          >
            {Math.round(zoom * 100)}%
          </span>
          <IconButton
            label="Zoom in (⌘=)"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom(zoom + ZOOM_STEP)}
          >
            <Plus size={14} aria-hidden="true" />
          </IconButton>
          <Button variant="subtle" disabled={zoom === 1} onClick={() => setZoom(1)}>
            Reset
          </Button>
        </div>
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          Zooms the entire interface. ⌘=, ⌘-, and ⌘0 work anywhere in the app.
        </p>
      </Card>
      <Card>
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Theme</span>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {unifiedThemes.map((theme) => (
            <ThemeSwatch
              key={theme.id}
              themeId={theme.id}
              mode={mode}
              selected={theme.id === themeId}
              onSelect={setThemeId}
              onArrowKey={moveSelection}
            />
          ))}
        </div>
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          Themes restyle the app chrome, terminals, and the code editor together.
        </p>
      </Card>
    </>
  );
}
