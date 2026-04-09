"use client";

import { useState, useEffect, useCallback } from "react";
import { saveTheme, useTheme, DEFAULT_THEME, type Theme } from "@/hooks/useTheme";
import { RETRO_THEME } from "@/lib/theme-presets";
import { saveDesktopConfig, useDesktopConfig, type DesktopConfig } from "@/hooks/useDesktopConfig";
import { useDesktopConfigStore, type DockConfig } from "@/stores/desktop-config";
import { getGatewayUrl } from "@/lib/gateway";
import { CheckIcon, UploadIcon, XIcon, ImageIcon, PaletteIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";

/* ── Theme Presets ─────────────────────────────── */

const PRESETS: { id: string; label: string; theme: Theme | null; gradient: string[] }[] = [
  {
    id: "sage",
    label: "Sage",
    theme: DEFAULT_THEME,
    gradient: ["#323D2E", "#9AA48C", "#8CC7BE", "#6a8a7a"],
  },
  {
    id: "retro",
    label: "Retro",
    theme: RETRO_THEME,
    gradient: ["#B0B0B0", "#C8C8C8", "#D4D4D4", "#008080"],
  },
  {
    id: "midnight",
    label: "Midnight",
    theme: null, // coming soon
    gradient: ["#1a1a2e", "#16213e", "#0f3460", "#533483"],
  },
];

/* ── Background Type ───────────────────────────── */

type BgMode = "pattern" | "solid" | "image";

/* ── Component ─────────────────────────────────── */

export function AppearanceSection() {
  useTheme(); // keep theme applied
  const config = useDesktopConfig();
  const setDock = useDesktopConfigStore((s) => s.setDock);

  const [activePreset, setActivePreset] = useState("sage");
  const [bgMode, setBgMode] = useState<BgMode>(
    config.background.type === "wallpaper" || config.background.type === "image"
      ? "image"
      : config.background.type === "solid"
        ? "solid"
        : "pattern",
  );
  const [solidColor, setSolidColor] = useState("#1c1917");
  const [wallpapers, setWallpapers] = useState<string[]>([]);
  const [selectedWallpaper, setSelectedWallpaper] = useState("");

  // Gradient colors — read initial values from CSS vars
  const [gradColors, setGradColors] = useState(() => ({
    deep: "#323D2E",
    mid: "#9AA48C",
    light: "#8CC7BE",
    accent: "#6a8a7a",
  }));

  const dock = config.dock;

  useEffect(() => {
    const bg = config.background;
    if (bg.type === "solid") setSolidColor(bg.color);
    if (bg.type === "wallpaper") setSelectedWallpaper(bg.name);
  }, [config.background]);

  const fetchWallpapers = useCallback(async () => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/settings/wallpapers`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = await res.json();
        setWallpapers(data.wallpapers || []);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchWallpapers();
  }, [fetchWallpapers]);

  function updateGradient(key: keyof typeof gradColors, value: string) {
    setGradColors((prev) => ({ ...prev, [key]: value }));
    document.documentElement.style.setProperty(`--gradient-${key}`, value);
  }

  async function saveDock(next: DockConfig) {
    setDock(next);
    await saveDesktopConfig({ ...config, dock: next });
  }

  const saveBg = useCallback(
    async (background: DesktopConfig["background"]) => {
      await saveDesktopConfig({ ...config, background });
    },
    [config],
  );

  async function applyPreset(id: string) {
    const preset = PRESETS.find((p) => p.id === id);
    if (!preset?.theme) return;
    setActivePreset(id);
    await saveTheme(preset.theme);
    // Auto-set background to match theme style
    if (preset.theme.style === "neumorphic") {
      setBgMode("solid");
      const bgColor = preset.theme.colors.background || "#D4D4D4";
      setSolidColor(bgColor);
      await saveBg({ type: "solid", color: bgColor });
    } else {
      setBgMode("pattern");
      await saveBg({ type: "pattern" });
    }
  }

  async function selectBgMode(mode: BgMode) {
    setBgMode(mode);
    if (mode === "pattern") await saveBg({ type: "pattern" });
    if (mode === "solid") await saveBg({ type: "solid", color: solidColor });
  }

  async function handleSolidChange(color: string) {
    setSolidColor(color);
    await saveBg({ type: "solid", color });
  }

  async function handleWallpaperSelect(name: string) {
    setSelectedWallpaper(name);
    setBgMode("image");
    await saveBg({ type: "wallpaper", name });
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await fetch(`${getGatewayUrl()}/api/settings/wallpaper`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, data: reader.result }),
          signal: AbortSignal.timeout(30_000),
        });
        await fetchWallpapers();
      } catch {
        // ignore
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  async function handleDeleteWallpaper(name: string) {
    try {
      await fetch(
        `${getGatewayUrl()}/api/settings/wallpaper/${encodeURIComponent(name)}`,
        { method: "DELETE", signal: AbortSignal.timeout(10_000) },
      );
      await fetchWallpapers();
      if (selectedWallpaper === name) {
        setBgMode("pattern");
        await saveBg({ type: "pattern" });
      }
    } catch {
      // ignore
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <h2 className="text-lg font-semibold">Appearance</h2>

      {/* ── Theme Presets ──────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Theme</h3>
        <div className="grid grid-cols-3 gap-3">
          {PRESETS.map((preset) => {
            const isActive = activePreset === preset.id;
            const isAvailable = preset.theme !== null;
            return (
              <button
                key={preset.id}
                onClick={() => isAvailable && applyPreset(preset.id)}
                disabled={!isAvailable}
                className={`relative flex flex-col rounded-xl border-2 p-3 transition-all ${
                  isActive
                    ? "border-primary bg-primary/5"
                    : isAvailable
                      ? "border-border hover:border-primary/40"
                      : "border-border/50 opacity-50 cursor-not-allowed"
                }`}
              >
                {/* Color swatch row */}
                <div className="flex h-8 w-full rounded-lg overflow-hidden mb-2">
                  {preset.gradient.map((color, i) => (
                    <div key={i} className="flex-1" style={{ backgroundColor: color }} />
                  ))}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{preset.label}</span>
                  {isActive && (
                    <CheckIcon className="size-4 text-primary" />
                  )}
                  {!isAvailable && (
                    <span className="text-[10px] text-muted-foreground">Coming soon</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Background ─────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Background</h3>

        {/* Mode selector */}
        <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
          {(
            [
              { id: "pattern", label: "Gradient", icon: PaletteIcon },
              { id: "solid", label: "Solid", icon: PaletteIcon },
              { id: "image", label: "Image", icon: ImageIcon },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              onClick={() => selectBgMode(opt.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
                bgMode === opt.id
                  ? "bg-background text-foreground font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <opt.icon className="size-3.5" />
              {opt.label}
            </button>
          ))}
        </div>

        {/* Gradient colors */}
        {bgMode === "pattern" && (
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">Customize the mesh gradient colors</p>
            <div className="flex gap-2">
              {(
                [
                  { key: "deep", label: "Deep" },
                  { key: "mid", label: "Mid" },
                  { key: "light", label: "Light" },
                  { key: "accent", label: "Accent" },
                ] as const
              ).map((c) => (
                <label key={c.key} className="flex flex-col items-center gap-1.5 flex-1">
                  <div className="relative w-full">
                    <input
                      type="color"
                      value={gradColors[c.key]}
                      onChange={(e) => updateGradient(c.key, e.target.value)}
                      className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                    <div
                      className="w-full h-10 rounded-lg border border-border cursor-pointer transition-shadow hover:shadow-md"
                      style={{ backgroundColor: gradColors[c.key] }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground">{c.label}</span>
                </label>
              ))}
            </div>
            {/* Live preview */}
            <div
              className="h-12 rounded-lg border border-border overflow-hidden"
              style={{
                background: [
                  `radial-gradient(ellipse at 20% 80%, ${gradColors.deep} 0%, transparent 60%)`,
                  `radial-gradient(ellipse at 80% 15%, ${gradColors.light} 0%, transparent 55%)`,
                  `radial-gradient(ellipse at 50% 50%, ${gradColors.mid} 0%, transparent 70%)`,
                  `radial-gradient(ellipse at 75% 70%, ${gradColors.accent} 0%, transparent 50%)`,
                  gradColors.mid,
                ].join(", "),
              }}
            />
          </div>
        )}

        {/* Solid */}
        {bgMode === "solid" && (
          <div className="flex items-center gap-3 py-2">
            <label className="relative">
              <input
                type="color"
                value={solidColor}
                onChange={(e) => handleSolidChange(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <div
                className="size-10 rounded-lg border border-border shadow-sm cursor-pointer"
                style={{ backgroundColor: solidColor }}
              />
            </label>
            <div>
              <p className="text-sm font-medium">Solid color</p>
              <p className="text-xs text-muted-foreground font-mono">{solidColor}</p>
            </div>
          </div>
        )}

        {/* Image */}
        {bgMode === "image" && (
          <div className="space-y-3 py-2">
            {wallpapers.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {wallpapers.map((name) => (
                  <div key={name} className="relative group">
                    <button
                      onClick={() => handleWallpaperSelect(name)}
                      className={`w-full aspect-video rounded-lg border-2 overflow-hidden transition-all ${
                        selectedWallpaper === name
                          ? "border-primary ring-1 ring-primary/30"
                          : "border-border hover:border-primary/40"
                      }`}
                    >
                      <img
                        src={`${getGatewayUrl()}/files/system/wallpapers/${name}`}
                        alt={name}
                        className="w-full h-full object-cover"
                      />
                    </button>
                    <button
                      onClick={() => handleDeleteWallpaper(name)}
                      className="absolute top-1 right-1 size-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <label className="flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border py-6 cursor-pointer hover:border-primary/40 hover:bg-muted/30 transition-colors">
              <UploadIcon className="size-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Upload image</span>
              <input
                type="file"
                accept="image/*"
                onChange={handleUpload}
                className="hidden"
              />
            </label>
          </div>
        )}
      </section>

      {/* ── Dock ───────────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Dock</h3>

        {/* Position */}
        <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
          {(["left", "right", "bottom"] as const).map((pos) => (
            <button
              key={pos}
              onClick={() => saveDock({ ...dock, position: pos })}
              className={`flex-1 rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${
                dock.position === pos
                  ? "bg-background text-foreground font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {pos}
            </button>
          ))}
        </div>

        {/* Size */}
        <div className="flex items-center gap-3">
          <span className="text-sm min-w-[70px]">Size</span>
          <input
            type="range"
            min={36}
            max={64}
            step={2}
            value={dock.size}
            onChange={(e) => saveDock({ ...dock, size: Number(e.target.value) })}
            className="flex-1 h-1 accent-primary cursor-pointer"
          />
          <span className="text-xs text-muted-foreground font-mono w-10 text-right">{dock.size}px</span>
        </div>

        {/* Show on hover */}
        <div className="flex items-center justify-between py-1">
          <div>
            <span className="text-sm">Show on hover</span>
            <p className="text-xs text-muted-foreground">Hide the dock until you hover near the edge</p>
          </div>
          <Switch
            checked={dock.autoHide}
            onCheckedChange={(checked) => saveDock({ ...dock, autoHide: checked })}
          />
        </div>
      </section>
    </div>
  );
}
