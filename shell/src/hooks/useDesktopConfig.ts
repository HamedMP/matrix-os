"use client";

import { useEffect, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";
import { useDesktopConfigStore, type DockConfig } from "@/stores/desktop-config";
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
}

const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  background: { type: "pattern" },
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
  pinnedApps: [],
};

export const MESH_GRADIENT = [
  "radial-gradient(ellipse at 15% 85%, hsla(25, 55%, 50%, 0.22) 0%, transparent 50%)",
  "radial-gradient(ellipse at 85% 10%, hsla(252, 70%, 68%, 0.18) 0%, transparent 50%)",
  "radial-gradient(ellipse at 50% 50%, hsla(280, 25%, 82%, 0.35) 0%, transparent 65%)",
  "radial-gradient(ellipse at 75% 75%, hsla(195, 45%, 65%, 0.12) 0%, transparent 45%)",
  "radial-gradient(ellipse at 30% 20%, hsla(340, 40%, 70%, 0.1) 0%, transparent 40%)",
  "linear-gradient(145deg, #ede6f1 0%, #e4daec 35%, #ddd1e7 55%, #e8dced 75%, #ede6f1 100%)",
].join(", ");

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
      body.style.background = MESH_GRADIENT;
      body.style.backgroundAttachment = "fixed";
      break;
    case "solid":
      body.style.backgroundColor = config.color;
      break;
    case "gradient":
      body.style.background = `linear-gradient(${config.angle ?? 135}deg, ${config.from}, ${config.to})`;
      break;
    case "wallpaper":
      body.style.backgroundImage = `url(${gatewayUrl}/files/system/wallpapers/${config.name})`;
      body.style.backgroundSize = "cover";
      body.style.backgroundPosition = "center";
      body.style.backgroundRepeat = "no-repeat";
      break;
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
  const gatewayUrl = getGatewayUrl();

  useEffect(() => {
    fetchDesktopConfig(gatewayUrl).then((cfg) => {
      setConfig(cfg);
      setDock(cfg.dock);
      setPinnedApps(cfg.pinnedApps);
      applyBackground(cfg.background, gatewayUrl);
    });
  }, [gatewayUrl, setDock, setPinnedApps]);

  useEffect(() => {
    applyBackground(config.background, gatewayUrl);
  }, [config, gatewayUrl]);

  useFileWatcher((path, event) => {
    if (path === "system/desktop.json" && event !== "unlink") {
      fetchDesktopConfig(gatewayUrl).then((cfg) => {
        setConfig(cfg);
        setDock(cfg.dock);
        setPinnedApps(cfg.pinnedApps);
      });
    }
  });

  return config;
}

async function fetchDesktopConfig(gatewayUrl: string): Promise<DesktopConfig> {
  try {
    const res = await fetch(`${gatewayUrl}/api/settings/desktop`);
    if (res.ok) {
      const data = await res.json();
      return { ...DEFAULT_DESKTOP_CONFIG, ...data };
    }
  } catch {
    // fall through
  }
  return DEFAULT_DESKTOP_CONFIG;
}

export async function saveDesktopConfig(config: DesktopConfig): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  await fetch(`${gatewayUrl}/api/settings/desktop`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}
