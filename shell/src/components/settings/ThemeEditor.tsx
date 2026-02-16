"use client";

import { useState } from "react";
import { THEME_PRESETS, getPreset } from "@/lib/theme-presets";
import { saveTheme, type Theme } from "@/hooks/useTheme";
import { useTheme } from "@/hooks/useTheme";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { ColorPicker } from "./ColorPicker";

const COLOR_CATEGORIES: { label: string; keys: string[] }[] = [
  { label: "Base", keys: ["background", "foreground"] },
  { label: "Cards", keys: ["card", "card-foreground", "popover", "popover-foreground"] },
  { label: "Primary", keys: ["primary", "primary-foreground"] },
  { label: "Secondary", keys: ["secondary", "secondary-foreground"] },
  { label: "Muted", keys: ["muted", "muted-foreground"] },
  { label: "Accent", keys: ["accent", "accent-foreground"] },
  { label: "Status", keys: ["destructive", "success", "warning"] },
  { label: "Chrome", keys: ["border", "input", "ring"] },
];

const SANS_FONTS = [
  "Inter, system-ui, sans-serif",
  "system-ui, sans-serif",
  "Helvetica Neue, sans-serif",
  "Georgia, serif",
];

const MONO_FONTS = [
  "JetBrains Mono, monospace",
  "Fira Code, monospace",
  "Source Code Pro, monospace",
  "Menlo, monospace",
];

export function ThemeEditor() {
  const currentTheme = useTheme();
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const [saving, setSaving] = useState(false);

  function updateColor(key: string, value: string) {
    setTheme((t) => ({ ...t, colors: { ...t.colors, [key]: value } }));
  }

  function updateFont(key: string, value: string) {
    setTheme((t) => ({ ...t, fonts: { ...t.fonts, [key]: value } }));
  }

  function updateRadius(value: number) {
    setTheme((t) => ({ ...t, radius: `${value}rem` }));
  }

  async function applyPreset(name: string) {
    const preset = getPreset(name);
    if (!preset) return;
    setTheme(preset);
    setSaving(true);
    await saveTheme(preset);
    setSaving(false);
  }

  async function handleSave() {
    setSaving(true);
    await saveTheme(theme);
    setSaving(false);
  }

  async function handleReset() {
    await applyPreset("default");
  }

  const radiusValue = parseFloat(theme.radius) || 0.75;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Presets</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 flex-wrap">
            {THEME_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => applyPreset(preset.name)}
                className={`flex flex-col items-center gap-1 rounded-lg border p-2 transition-colors hover:border-primary ${
                  theme.name === preset.name
                    ? "border-primary ring-1 ring-primary"
                    : "border-border"
                }`}
              >
                <div className="flex h-6 w-12 rounded overflow-hidden">
                  <div
                    className="flex-1"
                    style={{ backgroundColor: preset.colors.background }}
                  />
                  <div
                    className="flex-1"
                    style={{ backgroundColor: preset.colors.primary }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground capitalize">
                  {preset.name}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Colors</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {COLOR_CATEGORIES.map((cat) => (
            <div key={cat.label}>
              <h4 className="text-xs font-medium text-muted-foreground mb-2">
                {cat.label}
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {cat.keys.map((key) => (
                  <ColorPicker
                    key={key}
                    label={key}
                    value={theme.colors[key] || "#000000"}
                    onChange={(v) => updateColor(key, v)}
                  />
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Typography</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground">Sans Font</label>
            <select
              value={theme.fonts.sans}
              onChange={(e) => updateFont("sans", e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {SANS_FONTS.map((f) => (
                <option key={f} value={f}>
                  {f.split(",")[0]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Mono Font</label>
            <select
              value={theme.fonts.mono}
              onChange={(e) => updateFont("mono", e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {MONO_FONTS.map((f) => (
                <option key={f} value={f}>
                  {f.split(",")[0]}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Border Radius</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Slider
              min={0}
              max={1.5}
              step={0.25}
              value={[radiusValue]}
              onValueChange={([v]) => updateRadius(v)}
              className="flex-1"
            />
            <span className="text-sm font-mono text-muted-foreground w-16 text-right">
              {radiusValue}rem
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          onClick={handleReset}
          className="rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
