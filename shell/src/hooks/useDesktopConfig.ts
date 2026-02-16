"use client";

import { useEffect, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";
import { useDesktopConfigStore, type DockConfig } from "@/stores/desktop-config";

export interface DesktopConfig {
  background:
    | { type: "pattern" }
    | { type: "solid"; color: string }
    | { type: "gradient"; from: string; to: string; angle?: number }
    | { type: "wallpaper"; name: string }
    | { type: "image"; url: string; fit?: string };
  dock: DockConfig;
}

const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  background: { type: "pattern" },
  dock: { position: "left", size: 56, iconSize: 40, autoHide: false },
};

export const WAVES_PATTERN = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='800' viewBox='0 0 800 800'%3E%3Cg fill='none' stroke='%23c8b8d0' stroke-width='1' opacity='0.4'%3E%3Cpath d='M0 200 Q200 150 400 200 T800 200'/%3E%3Cpath d='M0 300 Q200 250 400 300 T800 300'/%3E%3Cpath d='M0 400 Q200 350 400 400 T800 400'/%3E%3Cpath d='M0 500 Q200 450 400 500 T800 500'/%3E%3Cpath d='M0 600 Q200 550 400 600 T800 600'/%3E%3Cpath d='M0 250 Q300 200 600 260 T800 240'/%3E%3Cpath d='M0 350 Q300 310 600 370 T800 340'/%3E%3Cpath d='M0 450 Q300 410 600 470 T800 440'/%3E%3Cpath d='M0 550 Q300 510 600 570 T800 540'/%3E%3C/g%3E%3C/svg%3E")`;

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
      body.style.backgroundImage = WAVES_PATTERN;
      body.style.backgroundSize = "cover";
      body.style.backgroundPosition = "center";
      body.style.backgroundRepeat = "no-repeat";
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
  const gatewayUrl = getGatewayUrl();

  useEffect(() => {
    fetchDesktopConfig(gatewayUrl).then((cfg) => {
      setConfig(cfg);
      setDock(cfg.dock);
      applyBackground(cfg.background, gatewayUrl);
    });
  }, [gatewayUrl, setDock]);

  useEffect(() => {
    applyBackground(config.background, gatewayUrl);
  }, [config, gatewayUrl]);

  useFileWatcher((path, event) => {
    if (path === "system/desktop.json" && event !== "unlink") {
      fetchDesktopConfig(gatewayUrl).then((cfg) => {
        setConfig(cfg);
        setDock(cfg.dock);
      });
    }
  });

  return config;
}

async function fetchDesktopConfig(gatewayUrl: string): Promise<DesktopConfig> {
  try {
    const res = await fetch(`${gatewayUrl}/api/settings/desktop`);
    if (res.ok) return res.json();
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
