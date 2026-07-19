"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { useFileWatcher } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";
import { useDesktopConfigStore, type DockConfig } from "@/stores/desktop-config";
import { DEFAULT_PINNED_APPS } from "@/lib/builtin-apps";
import {
  loadShellSnapshot,
  saveShellSnapshot,
  type ShellSnapshotScope,
} from "@/lib/shell-snapshot-cache";
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

interface DesktopConfigRuntimeCache {
  gatewayUrl: string;
  config: DesktopConfig;
}

let desktopConfigRuntimeCache: DesktopConfigRuntimeCache | null = null;

function rememberDesktopConfig(gatewayUrl: string, config: DesktopConfig): void {
  desktopConfigRuntimeCache = { gatewayUrl, config };
}

function initialDesktopConfig(
  cacheScope: ShellSnapshotScope | null,
  gatewayUrl: string,
): DesktopConfig {
  // A scoped shell root starts from its own user/runtime snapshot. Nested
  // consumers may reuse only the current gateway's applied config so opening
  // Settings cannot repaint another computer's/default wallpaper.
  if (cacheScope) {
    return loadShellSnapshot(cacheScope)?.desktopConfig ?? DEFAULT_DESKTOP_CONFIG;
  }
  return desktopConfigRuntimeCache?.gatewayUrl === gatewayUrl
    ? desktopConfigRuntimeCache.config
    : DEFAULT_DESKTOP_CONFIG;
}

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

interface DesktopConfigHookOptions {
  cacheScope?: ShellSnapshotScope | null;
}

function applyDesktopConfigSnapshot(
  cfg: DesktopConfig,
  gatewayUrl: string,
  setters: {
    setDock: (dock: DockConfig) => void;
    setPinnedApps: (apps: string[]) => void;
    setDockOrder: (order: DesktopConfig["dockOrder"]) => void;
  },
) {
  rememberDesktopConfig(gatewayUrl, cfg);
  setters.setDock(cfg.dock);
  setters.setPinnedApps(cfg.pinnedApps);
  setters.setDockOrder(cfg.dockOrder);
  applyBackground(cfg.background, gatewayUrl);
}

export function useDesktopConfig(options: DesktopConfigHookOptions = {}) {
  const cacheScope = options.cacheScope ?? null;
  const cacheKey = cacheScope?.storageKey;
  const gatewayUrl = getGatewayUrl();
  const [config, setConfig] = useState<DesktopConfig>(() => initialDesktopConfig(cacheScope, gatewayUrl));
  const setDock = useDesktopConfigStore((s) => s.setDock);
  const setPinnedApps = useDesktopConfigStore((s) => s.setPinnedApps);
  const setDockOrder = useDesktopConfigStore((s) => s.setDockOrder);

  useLayoutEffect(() => {
    const cachedConfig = loadShellSnapshot(cacheScope)?.desktopConfig;
    if (!cachedConfig) return;
    applyDesktopConfigSnapshot(cachedConfig, gatewayUrl, { setDock, setPinnedApps, setDockOrder });
  }, [cacheKey, cacheScope, gatewayUrl, setDock, setPinnedApps, setDockOrder]);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- the setConfig/setDock/setPinnedApps/setDockOrder calls all populate distinct stores from a single fetched desktop-config payload inside one async .then callback; they run together once the load resolves, not as a synchronous render-time cascade, and target separate Zustand slices that cannot be collapsed
  useEffect(() => {
    const controller = new AbortController();
    fetchDesktopConfig(gatewayUrl, controller.signal).then((cfg) => {
      if (controller.signal.aborted) return;
      setConfig(cfg);
      applyDesktopConfigSnapshot(cfg, gatewayUrl, { setDock, setPinnedApps, setDockOrder });
      saveShellSnapshot(cacheScope, { desktopConfig: cfg });
    });

    return () => controller.abort();
  }, [cacheKey, cacheScope, gatewayUrl, setDock, setPinnedApps, setDockOrder]);

  useEffect(() => {
    rememberDesktopConfig(gatewayUrl, config);
    applyBackground(config.background, gatewayUrl);
  }, [config.background, gatewayUrl]);

  useFileWatcher((path, event) => {
    if (path === "system/desktop.json" && event !== "unlink") {
      fetchDesktopConfig(gatewayUrl).then((cfg) => {
        setConfig(cfg);
        setDock(cfg.dock);
        setPinnedApps(cfg.pinnedApps);
        setDockOrder(cfg.dockOrder);
        saveShellSnapshot(cacheScope, { desktopConfig: cfg });
      });
    }
  });

  return config;
}

function settingsFetchSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function fetchDesktopConfig(gatewayUrl: string, signal?: AbortSignal): Promise<DesktopConfig> {
  try {
    const res = await fetch(`${gatewayUrl}/api/settings/desktop`, {
      signal: settingsFetchSignal(signal),
    });
    if (res.ok) {
      const data = await res.json();
      const merged = { ...DEFAULT_DESKTOP_CONFIG, ...data };
      merged.dock = { ...merged.dock, autoHide: false };
      return merged;
    }
  } catch (err) {
    if (signal?.aborted) return DEFAULT_DESKTOP_CONFIG;
    console.warn("[desktop-config] failed to load desktop config:", err instanceof Error ? err.message : String(err));
  }
  return DEFAULT_DESKTOP_CONFIG;
}

export function saveDesktopConfig(config: DesktopConfig): Promise<void>;
export function saveDesktopConfig(config: DesktopConfig, options: DesktopConfigHookOptions): Promise<void>;
export async function saveDesktopConfig(
  config: DesktopConfig,
  options: DesktopConfigHookOptions = {},
): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  const res = await fetch(`${gatewayUrl}/api/settings/desktop`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
    body: JSON.stringify(config),
  });
  if (res.ok) {
    saveShellSnapshot(options.cacheScope, { desktopConfig: config });
    const store = useDesktopConfigStore.getState();
    applyDesktopConfigSnapshot(config, gatewayUrl, store);
  }
}

export async function saveDesktopConfigPatch(
  patch: Partial<DesktopConfig>,
  options: DesktopConfigHookOptions = {},
): Promise<void> {
  const gatewayUrl = getGatewayUrl();
  const url = `${gatewayUrl}/api/settings/desktop`;
  const getRes = await fetch(url, {
    signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
  });
  const config = getRes.ok
    ? (await getRes.json()) as Record<string, unknown>
    : {};
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  const nextConfig = { ...config, ...definedPatch };
  const putRes = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
    body: JSON.stringify(nextConfig),
  });
  if (!putRes.ok) {
    throw new Error(`PUT /api/settings/desktop ${putRes.status}`);
  }
  const dockValue = nextConfig.dock;
  const normalizedConfig = {
    ...DEFAULT_DESKTOP_CONFIG,
    ...nextConfig,
    dock: {
      ...DEFAULT_DESKTOP_CONFIG.dock,
      ...(typeof dockValue === "object" && dockValue !== null && !Array.isArray(dockValue) ? dockValue : {}),
      autoHide: false,
    },
    pinnedApps: Array.isArray(nextConfig.pinnedApps)
      ? nextConfig.pinnedApps.filter((value): value is string => typeof value === "string")
      : DEFAULT_DESKTOP_CONFIG.pinnedApps,
  } as DesktopConfig;
  saveShellSnapshot(options.cacheScope, { desktopConfig: normalizedConfig });
  const store = useDesktopConfigStore.getState();
  applyDesktopConfigSnapshot(normalizedConfig, gatewayUrl, store);
}

/** Test hook: clear the module-local current-runtime desktop snapshot. */
export function resetDesktopConfigRuntimeCacheForTests(): void {
  desktopConfigRuntimeCache = null;
}
