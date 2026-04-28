"use client";

import { useEffect, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";
import { useDesktopConfigStore, type DockConfig } from "@/stores/desktop-config";
import { DEFAULT_PINNED_APPS } from "@/lib/builtin-apps";
export type { DockConfig };

export interface DesktopConfig {
  background:
    | { type: "pattern" }
    | { type: "solid"; color: string }
    | { type: "gradient"; from: string; to: string; angle?: number }
    | { type: "wallpaper"; name: string }
    | { type: "image"; url: string; fit?: string };
  dock: DockConfig;
  pinnedApps: string[];
  iconStyle?: string;
  /** Per-section dock ordering. User-generated apps in the outer section,
      system apps adjacent to the system controls. Most-recent / outermost
      first in each array. Missing means default sort (launch-time desc). */
  dockOrder?: {
    userApps?: string[];
    systemApps?: string[];
  };
}

const BUNDLED_WALLPAPERS = new Set(["moraine-lake.jpg"]);
const SETTINGS_FETCH_TIMEOUT_MS = 10_000;

const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  background: { type: "wallpaper", name: "moraine-lake.jpg" },
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
  pinnedApps: [...DEFAULT_PINNED_APPS],
};

// Page background mesh gradient — uses --gradient-* tokens from :root.
// These are separate from --background (which controls app window tint).
// Change the gradient by editing the --gradient-* vars in globals.css.
export function buildMeshGradient(): string {
  return [
    "radial-gradient(ellipse at 20% 80%, var(--gradient-deep) 0%, transparent 60%)",
    "radial-gradient(ellipse at 80% 15%, var(--gradient-light) 0%, transparent 55%)",
    "radial-gradient(ellipse at 50% 50%, var(--gradient-mid) 0%, transparent 70%)",
    "radial-gradient(ellipse at 75% 70%, var(--gradient-accent) 0%, transparent 50%)",
    "radial-gradient(ellipse at 10% 20%, var(--gradient-deep) 0%, transparent 45%)",
    "var(--gradient-mid)",
  ].join(", ");
}

function applyBackground(config: DesktopConfig["background"], gatewayUrl: string) {
  const body = document.body;

  body.style.backgroundImage = "";
  body.style.backgroundColor = "";
  body.style.background = "";
  body.style.backgroundSize = "";
  body.style.backgroundPosition = "";
  body.style.backgroundRepeat = "";

  switch (config.type) {
    case "pattern":
      body.style.background = buildMeshGradient();
      body.style.backgroundAttachment = "fixed";
      break;
    case "solid":
      body.style.backgroundColor = config.color;
      break;
    case "gradient":
      body.style.background = `linear-gradient(${config.angle ?? 135}deg, ${config.from}, ${config.to})`;
      break;
    case "wallpaper": {
      // Bundled defaults live in shell/public/wallpapers and work even when
      // the gateway is unreachable. User-uploaded wallpapers are served by
      // the gateway under /files/system/wallpapers.
      const url = BUNDLED_WALLPAPERS.has(config.name)
        ? `/wallpapers/${config.name}`
        : `${gatewayUrl}/files/system/wallpapers/${config.name}`;
      body.style.backgroundImage = `url(${url})`;
      body.style.backgroundSize = "cover";
      body.style.backgroundPosition = "center";
      body.style.backgroundRepeat = "no-repeat";
      break;
    }
    case "image":
      body.style.backgroundImage = `url(${config.url})`;
      body.style.backgroundSize = config.fit ?? "cover";
      body.style.backgroundPosition = "center";
      body.style.backgroundRepeat = "no-repeat";
      break;
  }
}

export function useDesktopConfig() {
  const [config, setConfig] = useState<DesktopConfig>(DEFAULT_DESKTOP_CONFIG);
  const setDock = useDesktopConfigStore((s) => s.setDock);
  const setPinnedApps = useDesktopConfigStore((s) => s.setPinnedApps);
  const setDockOrder = useDesktopConfigStore((s) => s.setDockOrder);
  const gatewayUrl = getGatewayUrl();

  useEffect(() => {
    fetchDesktopConfig(gatewayUrl).then((cfg) => {
      setConfig(cfg);
      setDock(cfg.dock);
      setPinnedApps(cfg.pinnedApps);
      setDockOrder(cfg.dockOrder);
      applyBackground(cfg.background, gatewayUrl);
    });
  }, [gatewayUrl, setDock, setPinnedApps, setDockOrder]);

  useEffect(() => {
    applyBackground(config.background, gatewayUrl);
  }, [config.background, gatewayUrl]);

  useFileWatcher((path, event) => {
    if (path === "system/desktop.json" && event !== "unlink") {
      fetchDesktopConfig(gatewayUrl).then((cfg) => {
        setConfig(cfg);
        setDock(cfg.dock);
        setPinnedApps(cfg.pinnedApps);
        setDockOrder(cfg.dockOrder);
      });
    }
  });

  return config;
}

async function fetchDesktopConfig(gatewayUrl: string): Promise<DesktopConfig> {
  try {
    const res = await fetch(`${gatewayUrl}/api/settings/desktop`, {
      signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = await res.json();
      const merged = { ...DEFAULT_DESKTOP_CONFIG, ...data };
      merged.dock = { ...merged.dock, autoHide: false };
      return merged;
    }
  } catch (err) {
    console.warn("[desktop-config] failed to load desktop config:", err instanceof Error ? err.message : String(err));
  }
  return DEFAULT_DESKTOP_CONFIG;
}

export async function saveDesktopConfig(config: DesktopConfig): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  await fetch(`${gatewayUrl}/api/settings/desktop`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
    body: JSON.stringify(config),
  });
}
