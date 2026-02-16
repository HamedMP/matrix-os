"use client";

import { useState, useEffect, useCallback } from "react";
import { saveDesktopConfig, useDesktopConfig, type DesktopConfig } from "@/hooks/useDesktopConfig";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { ColorPicker } from "./ColorPicker";
import { getGatewayUrl } from "@/lib/gateway";

type BgType = "pattern" | "solid" | "gradient" | "wallpaper";

const BG_TYPES: { id: BgType; label: string }[] = [
  { id: "pattern", label: "Pattern" },
  { id: "solid", label: "Solid" },
  { id: "gradient", label: "Gradient" },
  { id: "wallpaper", label: "Wallpaper" },
];

export function BackgroundEditor() {
  const config = useDesktopConfig();
  const [bgType, setBgType] = useState<BgType>(config.background.type);
  const [solidColor, setSolidColor] = useState("#1c1917");
  const [gradFrom, setGradFrom] = useState("#c2703a");
  const [gradTo, setGradTo] = useState("#ece5f0");
  const [gradAngle, setGradAngle] = useState(135);
  const [wallpapers, setWallpapers] = useState<string[]>([]);
  const [selectedWallpaper, setSelectedWallpaper] = useState("");

  useEffect(() => {
    const bg = config.background;
    setBgType(bg.type);
    if (bg.type === "solid") setSolidColor(bg.color);
    if (bg.type === "gradient") {
      setGradFrom(bg.from);
      setGradTo(bg.to);
      setGradAngle(bg.angle ?? 135);
    }
    if (bg.type === "wallpaper") setSelectedWallpaper(bg.name);
  }, [config.background]);

  useEffect(() => {
    fetchWallpapers();
  }, []);

  async function fetchWallpapers() {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/settings/wallpapers`);
      if (res.ok) {
        const data = await res.json();
        setWallpapers(data.wallpapers || []);
      }
    } catch {
      // ignore
    }
  }

  const save = useCallback(
    async (background: DesktopConfig["background"]) => {
      await saveDesktopConfig({ ...config, background });
    },
    [config],
  );

  async function selectType(type: BgType) {
    setBgType(type);
    if (type === "pattern") {
      await save({ type: "pattern" });
    } else if (type === "solid") {
      await save({ type: "solid", color: solidColor });
    } else if (type === "gradient") {
      await save({ type: "gradient", from: gradFrom, to: gradTo, angle: gradAngle });
    }
  }

  async function handleSolidChange(color: string) {
    setSolidColor(color);
    await save({ type: "solid", color });
  }

  async function handleGradientChange(from: string, to: string, angle: number) {
    setGradFrom(from);
    setGradTo(to);
    setGradAngle(angle);
    await save({ type: "gradient", from, to, angle });
  }

  async function handleWallpaperSelect(name: string) {
    setSelectedWallpaper(name);
    await save({ type: "wallpaper", name });
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
      await fetch(`${getGatewayUrl()}/api/settings/wallpaper/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      await fetchWallpapers();
      if (selectedWallpaper === name) {
        setBgType("pattern");
        await save({ type: "pattern" });
      }
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Background Type</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            {BG_TYPES.map((t) => (
              <button
                key={t.id}
                onClick={() => selectType(t.id)}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  bgType === t.id
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {bgType === "pattern" && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Using default wave pattern
            </p>
          </CardContent>
        </Card>
      )}

      {bgType === "solid" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Solid Color</CardTitle>
          </CardHeader>
          <CardContent>
            <ColorPicker
              value={solidColor}
              onChange={handleSolidChange}
              label="Background"
            />
          </CardContent>
        </Card>
      )}

      {bgType === "gradient" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Gradient</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-4">
              <ColorPicker
                value={gradFrom}
                onChange={(v) => handleGradientChange(v, gradTo, gradAngle)}
                label="From"
              />
              <ColorPicker
                value={gradTo}
                onChange={(v) => handleGradientChange(gradFrom, v, gradAngle)}
                label="To"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Angle: {gradAngle}deg
              </label>
              <Slider
                min={0}
                max={360}
                step={1}
                value={[gradAngle]}
                onValueChange={([v]) =>
                  handleGradientChange(gradFrom, gradTo, v)
                }
              />
            </div>
            <div
              className="h-16 rounded-md border border-border"
              style={{
                background: `linear-gradient(${gradAngle}deg, ${gradFrom}, ${gradTo})`,
              }}
            />
          </CardContent>
        </Card>
      )}

      {bgType === "wallpaper" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Wallpaper</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {wallpapers.map((name) => (
                <div key={name} className="relative group">
                  <button
                    onClick={() => handleWallpaperSelect(name)}
                    className={`w-full aspect-video rounded-md border overflow-hidden transition-all ${
                      selectedWallpaper === name
                        ? "border-primary ring-1 ring-primary"
                        : "border-border hover:border-primary/50"
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
                    className="absolute top-1 right-1 size-5 rounded-full bg-destructive text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
            {wallpapers.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No wallpapers uploaded yet
              </p>
            )}
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted transition-colors">
              Upload
              <input
                type="file"
                accept="image/*"
                onChange={handleUpload}
                className="hidden"
              />
            </label>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
