"use client";

import { useState, useEffect, useCallback } from "react";
import { saveDesktopConfig, useDesktopConfig } from "@/hooks/useDesktopConfig";
import { useDesktopConfigStore, type DockConfig } from "@/stores/desktop-config";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

const POSITIONS: { id: DockConfig["position"]; label: string }[] = [
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "bottom", label: "Bottom" },
];

export function DockEditor() {
  const config = useDesktopConfig();
  const setDock = useDesktopConfigStore((s) => s.setDock);
  const [dock, setLocalDock] = useState<DockConfig>(config.dock);

  useEffect(() => {
    setLocalDock(config.dock);
  }, [config.dock]);

  const save = useCallback(
    async (next: DockConfig) => {
      setLocalDock(next);
      setDock(next);
      await saveDesktopConfig({ ...config, dock: next });
    },
    [config, setDock],
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Position</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            {POSITIONS.map((p) => (
              <button
                key={p.id}
                onClick={() => save({ ...dock, position: p.id })}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  dock.position === p.id
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Size</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground">
              Dock Size: {dock.size}px
            </label>
            <Slider
              min={40}
              max={80}
              step={2}
              value={[dock.size]}
              onValueChange={([v]) => save({ ...dock, size: v })}
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Icon Size: {dock.iconSize}px
            </label>
            <Slider
              min={28}
              max={56}
              step={2}
              value={[dock.iconSize]}
              onValueChange={([v]) => save({ ...dock, iconSize: v })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Behavior</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <label className="text-sm">Auto-hide</label>
            <Switch
              checked={dock.autoHide}
              onCheckedChange={(checked) =>
                save({ ...dock, autoHide: checked })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative h-24 w-full rounded-md border border-border bg-muted/30 overflow-hidden">
            {dock.position === "left" && (
              <div
                className="absolute left-0 top-0 h-full bg-card border-r border-border flex flex-col items-center justify-center gap-1 py-2"
                style={{ width: dock.size * 0.6 }}
              >
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded bg-muted-foreground/30"
                    style={{
                      width: dock.iconSize * 0.4,
                      height: dock.iconSize * 0.4,
                    }}
                  />
                ))}
              </div>
            )}
            {dock.position === "right" && (
              <div
                className="absolute right-0 top-0 h-full bg-card border-l border-border flex flex-col items-center justify-center gap-1 py-2"
                style={{ width: dock.size * 0.6 }}
              >
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded bg-muted-foreground/30"
                    style={{
                      width: dock.iconSize * 0.4,
                      height: dock.iconSize * 0.4,
                    }}
                  />
                ))}
              </div>
            )}
            {dock.position === "bottom" && (
              <div
                className="absolute bottom-0 left-0 w-full bg-card border-t border-border flex items-center justify-center gap-1 px-2"
                style={{ height: dock.size * 0.6 }}
              >
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="rounded bg-muted-foreground/30"
                    style={{
                      width: dock.iconSize * 0.4,
                      height: dock.iconSize * 0.4,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
