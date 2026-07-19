"use client";

import { useState, useEffect, useCallback, useId } from "react";
import { useTheme } from "@/hooks/useTheme";
import { saveDesktopConfigPatch, useDesktopConfig, buildMeshGradient, BUNDLED_WALLPAPERS, wallpaperUrl, type DesktopConfig } from "@/hooks/useDesktopConfig";
import { useDesktopConfigStore, type DockConfig } from "@/stores/desktop-config";
import { getGatewayUrl } from "@/lib/gateway";
import { UploadIcon, XIcon, ImageIcon, PaletteIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { DesignPicker } from "@/components/settings/DesignPicker";

/* ── Background Type ───────────────────────────── */

type BgMode = "pattern" | "solid" | "image";

/* ── Component ─────────────────────────────────── */

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- background-mode/color/wallpaper inputs are independent appearance controls, not a single cohesive state machine; a reducer would not simplify them
// react-doctor-disable-next-line react-doctor/no-giant-component -- cohesive single-purpose appearance panel (background, dock) whose JSX sections share local state and handlers; splitting would scatter that state across props/context without reducing complexity. Real decomposition is out of scope for this behavior-preserving pass.
export function AppearanceSection() {
  useTheme(); // keep theme applied
  const config = useDesktopConfig();
  const setDock = useDesktopConfigStore((s) => s.setDock);
  const solidColorId = useId();
  const dockSizeId = useId();

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
    light: "#B8C4A8",
    accent: "#6a8a7a",
  }));

  const dock = config.dock;

  // Bundled defaults ship with the shell, so they are always selectable in the
  // grid even when the gateway's wallpaper directory doesn't list them (e.g.
  // existing homes predate them, since template sync skips user wallpapers).
  const gridWallpapers = [...new Set([...BUNDLED_WALLPAPERS, ...wallpapers])];

  // Sync the editor inputs from the persisted background config using the
  // render-time prev-prop pattern instead of an effect.
  // react-doctor-disable-next-line react-doctor/no-derived-useState, react-doctor/rerender-state-only-in-handlers -- transition tracker, not a mirror: `prevBackground` IS read in render (the guard below). It must be state, not a ref, so the corrective synchronous re-render re-seeds the solid/wallpaper inputs when the persisted config changes.
  const [prevBackground, setPrevBackground] = useState(config.background);
  if (config.background !== prevBackground) {
    setPrevBackground(config.background);
    const bg = config.background;
    if (bg.type === "solid") setSolidColor(bg.color);
    if (bg.type === "wallpaper") setSelectedWallpaper(bg.name);
  }

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by the mount-load useEffect dependency array below; removing useCallback would re-run the effect on every render and refetch the wallpaper list in a loop.
  const fetchWallpapers = useCallback(async () => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/settings/wallpapers`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = await res.json();
        setWallpapers(data.wallpapers || []);
      }
    } catch (err) {
      console.warn("[appearance] Failed to fetch wallpapers:", err);
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- mount-only load of wallpapers from the gateway (external async read); setState lands in the fetch callback, which is the documented allowed pattern
    fetchWallpapers();
  }, [fetchWallpapers]);

  function updateGradient(key: keyof typeof gradColors, value: string) {
    setGradColors((prev) => ({ ...prev, [key]: value }));
    document.documentElement.style.setProperty(`--gradient-${key}`, value);
    // Re-apply body background since inline styles bake in CSS var values at parse time
    if (bgMode === "pattern") {
      // react-doctor-disable-next-line react-hooks-js/immutability -- intentional DOM side-effect: writing the live document.body inline style so the mesh gradient re-bakes its CSS-var values; this is not React state/prop mutation, and the global document is the correct write target.
      document.body.style.background = buildMeshGradient();
      // react-doctor-disable-next-line react-hooks-js/immutability -- intentional DOM side-effect: pinning the body background-attachment alongside the gradient above; this writes the live document.body, not React state/props.
      document.body.style.backgroundAttachment = "fixed";
    }
  }

  async function saveDock(next: DockConfig) {
    setDock(next);
    await saveDesktopConfigPatch({ dock: next });
  }

  const saveBg = async (background: DesktopConfig["background"]) => {
    await saveDesktopConfigPatch({ background });
  };

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
      } catch (err) {
        console.warn("[appearance] Failed to upload wallpaper:", err);
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
    } catch (err) {
      console.warn(`[appearance] Failed to delete wallpaper "${name}":`, err);
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <h2 className="text-lg font-semibold">Appearance</h2>

      {/* ── Design ───────────────────────────── */}
      <DesignPicker />

      {/* ── Background ─────────────────────────── */}
      <section className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground">Background</h3>

        {/* Mode selector */}
        <div className="flex gap-1 rounded-lg bg-muted/50 p-1">
          {(
            [
              { id: "image", label: "Image", icon: ImageIcon },
              { id: "pattern", label: "Gradient", icon: PaletteIcon },
              { id: "solid", label: "Solid", icon: PaletteIcon },
            ] as const
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
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
            <label htmlFor={solidColorId} className="relative">
              <input
                id={solidColorId}
                type="color"
                value={solidColor}
                onChange={(e) => handleSolidChange(e.target.value)}
                aria-label="Solid background color"
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
            {gridWallpapers.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {gridWallpapers.map((name) => (
                  <div key={name} className="relative group">
                    <button
                      type="button"
                      onClick={() => handleWallpaperSelect(name)}
                      className={`w-full aspect-video rounded-lg border-2 overflow-hidden transition-all ${
                        selectedWallpaper === name
                          ? "border-primary ring-1 ring-primary/30"
                          : "border-border hover:border-primary/40"
                      }`}
                    >
                      {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- wallpaper previews resolve to a bundled /wallpapers asset or a runtime gateway host that cannot be statically configured for next/image */}
                      <img
                        src={wallpaperUrl(name, getGatewayUrl())}
                        alt={name}
                        className="w-full h-full object-cover"
                      />
                    </button>
                    {!BUNDLED_WALLPAPERS.has(name) && (
                      <button
                        type="button"
                        onClick={() => handleDeleteWallpaper(name)}
                        aria-label={`Delete wallpaper ${name}`}
                        className="absolute top-1 right-1 size-5 rounded-full bg-black/60 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <XIcon className="size-3" />
                      </button>
                    )}
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
              type="button"
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
          <label htmlFor={dockSizeId} className="text-sm min-w-[70px]">Size</label>
          <input
            id={dockSizeId}
            type="range"
            min={36}
            max={64}
            step={2}
            value={dock.size}
            onChange={(e) => saveDock({ ...dock, size: Number(e.target.value) })}
            aria-label="Dock size"
            className="flex-1 h-1 accent-primary cursor-pointer"
          />
          <span className="text-xs text-muted-foreground font-mono w-10 text-right">{dock.size}px</span>
        </div>

        {/* Auto-hide stays wired underneath, but the shell is pinned on for now. */}
        <div className="flex items-center justify-between py-1">
          <div>
            <span className="text-sm">Show on hover</span>
            <p className="text-xs text-muted-foreground">Coming soon. The dock stays visible in this build.</p>
          </div>
          <Switch
            checked={false}
            disabled
            aria-label="Show dock on hover (coming soon)"
          />
        </div>
      </section>
    </div>
  );
}
