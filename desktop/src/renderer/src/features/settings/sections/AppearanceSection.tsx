import { Check } from "lucide-react";
import { Button } from "../../../design/primitives";
import { getThemeVariant, unifiedThemes } from "../../../design/themes";
import { resolveThemeMode, type ThemeMode } from "../../../design/themes/apply";
import { useAppearance } from "../../../stores/appearance";
import { Card, SectionHeader } from "./section-kit";

function ThemeSwatch({ themeId, mode, selected, onSelect }: {
  themeId: string;
  mode: ThemeMode;
  selected: boolean;
  onSelect: (themeId: string) => void;
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
      className="flex flex-col gap-2 rounded-lg border p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{
        borderColor: selected ? "var(--accent)" : "var(--border-subtle)",
        background: "var(--bg-surface)",
      }}
      onClick={() => onSelect(themeId)}
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
  const setMode = useAppearance((s) => s.setMode);
  const setThemeId = useAppearance((s) => s.setThemeId);

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
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Theme</span>
        <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {unifiedThemes.map((theme) => (
            <ThemeSwatch
              key={theme.id}
              themeId={theme.id}
              mode={mode}
              selected={theme.id === themeId}
              onSelect={setThemeId}
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
