"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { useCommandStore } from "@/stores/commands";
import { useDesktopMode } from "@/stores/desktop-mode";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { AppViewer } from "./AppViewer";
import { AIButton } from "./AIButton";
import { MissionControl } from "./MissionControl";
import { Settings } from "./Settings";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { KanbanSquareIcon, StoreIcon, MonitorIcon, SettingsIcon, PinOffIcon, RefreshCwIcon } from "lucide-react";
import { UserButton } from "./UserButton";
import { AmbientClock } from "./AmbientClock";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

export interface AppWindow {
  id: string;
  title: string;
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  zIndex: number;
}

interface LayoutWindow {
  path: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: "open" | "minimized" | "closed";
}

interface AppEntry {
  name: string;
  path: string;
  iconUrl?: string;
}

interface ModuleRegistryEntry {
  name: string;
  type: string;
  path: string;
  status: string;
}

interface ModuleMeta {
  name: string;
  entry?: string;
  entryPoint?: string;
  version?: string;
}

function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

let nextZ = 1;

function TrafficLights({
  onClose,
  onMinimize,
}: {
  onClose: () => void;
  onMinimize: () => void;
}) {
  return (
    <div className="group/traffic flex items-center gap-1.5 mr-2">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="size-3 rounded-full bg-[#ff5f57] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Close"
      >
        <span className="text-[8px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          x
        </span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onMinimize();
        }}
        className="size-3 rounded-full bg-[#febc2e] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Minimize"
      >
        <span className="text-[9px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          -
        </span>
      </button>
      <button
        className="size-3 rounded-full bg-[#28c840] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Maximize"
      />
    </div>
  );
}

function DockIcon({
  name,
  active,
  onClick,
  iconSize = 40,
  tooltipSide = "right",
  iconUrl,
  onUnpin,
  onRegenerateIcon,
}: {
  name: string;
  active: boolean;
  onClick: () => void;
  iconSize?: number;
  tooltipSide?: "left" | "right" | "top" | "bottom";
  iconUrl?: string;
  onUnpin?: () => void;
  onRegenerateIcon?: () => void;
}) {
  const initial = name.charAt(0).toUpperCase();

  const btn = (
    <button
      onClick={onClick}
      className={`relative flex items-center justify-center rounded-xl shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all overflow-hidden ${
        iconUrl ? "" : "bg-card border border-border/60"
      }`}
      style={{ width: iconSize, height: iconSize }}
    >
      {iconUrl ? (
        <img src={iconUrl} alt={name} className="size-full object-cover rounded-xl" />
      ) : (
        <span className="text-sm font-semibold text-foreground">
          {initial}
        </span>
      )}
      {active && (
        <span className="absolute -right-1 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-foreground" />
      )}
    </button>
  );

  if (!onUnpin && !onRegenerateIcon) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side={tooltipSide} sideOffset={8}>{name}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Tooltip>
            <TooltipTrigger asChild>{btn}</TooltipTrigger>
            <TooltipContent side={tooltipSide} sideOffset={8}>{name}</TooltipContent>
          </Tooltip>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[60]">
        {onUnpin && (
          <ContextMenuItem onSelect={onUnpin}>
            <PinOffIcon className="size-3.5 mr-2" />
            Unpin from Dock
          </ContextMenuItem>
        )}
        {onRegenerateIcon && (
          <ContextMenuItem onSelect={onRegenerateIcon}>
            <RefreshCwIcon className="size-3.5 mr-2" />
            Regenerate Icon
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface DesktopProps {
  storeOpen?: boolean;
  onToggleStore?: () => void;
}

export function Desktop({ storeOpen, onToggleStore }: DesktopProps) {
  const [windows, setWindows] = useState<AppWindow[]>([]);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [interacting, setInteracting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const dock = useDesktopConfigStore((s) => s.dock);
  const pinnedApps = useDesktopConfigStore((s) => s.pinnedApps) ?? [];
  const togglePin = useDesktopConfigStore((s) => s.togglePin);
  const isHorizontal = dock.position === "bottom";
  const tooltipSide: "left" | "right" | "top" = dock.position === "left" ? "right" : dock.position === "right" ? "left" : "top";
  const dockXOffset = dock.position === "left" ? dock.size + 20 : 20;

  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const resizeRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const generatingRef = useRef(new Set<string>());

  const checkAndGenerateIcon = useCallback((slug: string) => {
    if (generatingRef.current.has(slug)) return;
    const iconPath = `/files/system/icons/${slug}.png`;
    fetch(`${GATEWAY_URL}${iconPath}`, { method: "HEAD" }).then((res) => {
      if (res.ok) {
        setApps((prev) =>
          prev.map((a) =>
            nameToSlug(a.name) === slug ? { ...a, iconUrl: `${GATEWAY_URL}${iconPath}` } : a,
          ),
        );
      } else {
        generatingRef.current.add(slug);
        fetch(`${GATEWAY_URL}/api/apps/${slug}/icon`, { method: "POST" })
          .then((r) => {
            if (!r.ok) {
              r.json().then((d: { error?: string }) => console.warn(`Icon gen failed for "${slug}":`, d.error)).catch(() => {});
              return;
            }
            return r.json().then((data: { iconUrl: string }) => {
              setApps((prev) =>
                prev.map((a) =>
                  nameToSlug(a.name) === slug ? { ...a, iconUrl: `${GATEWAY_URL}${data.iconUrl}` } : a,
                ),
              );
            });
          })
          .catch((err) => console.warn(`Icon gen request failed for "${slug}":`, err))
          .finally(() => generatingRef.current.delete(slug));
      }
    }).catch(() => {});
  }, []);

  const regenerateIcon = useCallback((slug: string) => {
    generatingRef.current.add(slug);
    fetch(`${GATEWAY_URL}/api/apps/${slug}/icon`, { method: "POST" })
      .then((r) => {
        if (!r.ok) {
          r.json().then((d: { error?: string }) => console.warn(`Icon regen failed for "${slug}":`, d.error)).catch(() => {});
          return;
        }
        return r.json().then((data: { iconUrl: string }) => {
          const bustUrl = `${GATEWAY_URL}${data.iconUrl}?t=${Date.now()}`;
          setApps((prev) =>
            prev.map((a) =>
              nameToSlug(a.name) === slug ? { ...a, iconUrl: bustUrl } : a,
            ),
          );
        });
      })
      .catch((err) => console.warn(`Icon regen request failed for "${slug}":`, err))
      .finally(() => generatingRef.current.delete(slug));
  }, []);

  const addApp = useCallback((name: string, path: string) => {
    setApps((prev) => {
      if (prev.find((a) => a.path === path)) return prev;
      return [...prev, { name, path }];
    });
    const slug = nameToSlug(name);
    checkAndGenerateIcon(slug);
  }, [checkAndGenerateIcon]);

  const openWindow = useCallback((name: string, path: string) => {
    setWindows((prev) => {
      const existing = prev.find((w) => w.path === path);
      if (existing) {
        return prev.map((w) =>
          w.path === path
            ? { ...w, minimized: false, zIndex: nextZ++ }
            : w,
        );
      }
      return [
        ...prev,
        {
          id: `win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: name,
          path,
          x: dockXOffset + prev.length * 30,
          y: 20 + prev.length * 30,
          width: 640,
          height: 480,
          minimized: false,
          zIndex: nextZ++,
        },
      ];
    });
  }, [dockXOffset]);

  const closedPathsRef = useRef(new Set<string>());

  const loadModules = useCallback(async () => {
    try {
      const [layoutRes, modulesRes] = await Promise.all([
        fetch(`${GATEWAY_URL}/api/layout`).catch(() => null),
        fetch(`${GATEWAY_URL}/files/system/modules.json`).catch(() => null),
      ]);

      const savedLayout: { windows?: LayoutWindow[] } =
        layoutRes?.ok ? await layoutRes.json() : {};
      const savedWindows = savedLayout.windows ?? [];
      const layoutMap = new Map(savedWindows.map((w) => [w.path, w]));

      if (!modulesRes?.ok) return;
      const registry: ModuleRegistryEntry[] = await modulesRes.json();

      for (const mod of registry) {
        if (mod.status !== "active") continue;

        try {
          // Try module.json first (standard), fall back to manifest.json
          let metaRes = await fetch(
            `${GATEWAY_URL}/files/modules/${mod.name}/module.json`,
          );
          if (!metaRes.ok) {
            metaRes = await fetch(
              `${GATEWAY_URL}/files/modules/${mod.name}/manifest.json`,
            );
          }
          if (!metaRes.ok) continue;
          const meta: ModuleMeta = await metaRes.json();
          const entryFile = meta.entry ?? meta.entryPoint ?? "index.html";
          const path = `modules/${mod.name}/${entryFile}`;

          addApp(meta.name, path);

          const saved = layoutMap.get(path);
          if (saved) {
            if (saved.state === "closed") {
              closedPathsRef.current.add(path);
              continue;
            }
            setWindows((prev) => {
              if (prev.find((w) => w.path === path)) return prev;
              return [
                ...prev,
                {
                  id: `win-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                  title: saved.title,
                  path,
                  x: saved.x,
                  y: saved.y,
                  width: saved.width,
                  height: saved.height,
                  minimized: saved.state === "minimized",
                  zIndex: nextZ++,
                },
              ];
            });
          } else {
            openWindow(meta.name, path);
          }
        } catch {
          // module.json missing or invalid, skip
        }
      }
    } catch {
      // modules.json not available yet
    }
  }, [addApp, openWindow]);

  useEffect(() => {
    loadModules();
  }, [loadModules]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const layoutWindows: LayoutWindow[] = windows.map((w) => ({
        path: w.path,
        title: w.title,
        x: w.x,
        y: w.y,
        width: w.width,
        height: w.height,
        state: w.minimized ? "minimized" : "open",
      }));

      for (const path of closedPathsRef.current) {
        if (!layoutWindows.find((lw) => lw.path === path)) {
          const app = apps.find((a) => a.path === path);
          layoutWindows.push({
            path,
            title: app?.name ?? path,
            x: 0,
            y: 0,
            width: 640,
            height: 480,
            state: "closed",
          });
        }
      }

      fetch(`${GATEWAY_URL}/api/layout`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ windows: layoutWindows }),
      }).catch(() => {});
    }, 500);

    return () => clearTimeout(saveTimerRef.current);
  }, [windows, apps]);

  useFileWatcher(
    useCallback(
      (path: string, event: string) => {
        if (path === "system/modules.json" && event !== "unlink") {
          loadModules();
          return;
        }

        if (path.startsWith("apps/")) {
          const name = path.replace("apps/", "").replace(".html", "");
          if (event === "unlink") {
            setApps((prev) => prev.filter((a) => a.path !== path));
            setWindows((prev) => prev.filter((w) => w.path !== path));
          } else {
            addApp(name, path);
            openWindow(name, path);
          }
        }
      },
      [loadModules, addApp, openWindow],
    ),
  );

  const bringToFront = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, zIndex: nextZ++ } : w)),
    );
  }, []);

  const closeWindow = useCallback((id: string) => {
    setWindows((prev) => {
      const win = prev.find((w) => w.id === id);
      if (win) closedPathsRef.current.add(win.path);
      return prev.filter((w) => w.id !== id);
    });
  }, []);

  const minimizeWindow = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((w) =>
        w.id === id ? { ...w, minimized: true } : w,
      ),
    );
  }, []);

  const onDragStart = useCallback(
    (id: string, e: React.PointerEvent) => {
      e.preventDefault();
      const win = windows.find((w) => w.id === id);
      if (!win) return;
      dragRef.current = {
        id,
        startX: e.clientX,
        startY: e.clientY,
        origX: win.x,
        origY: win.y,
      };
      setInteracting(true);
      bringToFront(id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [windows, bringToFront],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { id, startX, startY, origX, origY } = dragRef.current;
    setWindows((prev) =>
      prev.map((w) =>
        w.id === id
          ? {
              ...w,
              x: origX + (e.clientX - startX),
              y: origY + (e.clientY - startY),
            }
          : w,
      ),
    );
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setInteracting(false);
  }, []);

  const onResizeStart = useCallback(
    (id: string, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const win = windows.find((w) => w.id === id);
      if (!win) return;
      resizeRef.current = {
        id,
        startX: e.clientX,
        startY: e.clientY,
        origW: win.width,
        origH: win.height,
      };
      setInteracting(true);
      bringToFront(id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [windows, bringToFront],
  );

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const { id, startX, startY, origW, origH } = resizeRef.current;
    setWindows((prev) =>
      prev.map((w) =>
        w.id === id
          ? {
              ...w,
              width: Math.max(MIN_WIDTH, origW + (e.clientX - startX)),
              height: Math.max(MIN_HEIGHT, origH + (e.clientY - startY)),
            }
          : w,
      ),
    );
  }, []);

  const onResizeEnd = useCallback(() => {
    resizeRef.current = null;
    setInteracting(false);
  }, []);

  const [taskBoardOpen, setTaskBoardOpen] = useState(false);

  const register = useCommandStore((s) => s.register);
  const unregister = useCommandStore((s) => s.unregister);
  const desktopMode = useDesktopMode((s) => s.mode);
  const setDesktopMode = useDesktopMode((s) => s.setMode);
  const allModes = useDesktopMode((s) => s.allModes);
  const getModeConfig = useDesktopMode((s) => s.getModeConfig);
  const modeConfig = getModeConfig(desktopMode);

  const modes = allModes();
  const cycleMode = useCallback(() => {
    const idx = modes.findIndex((m) => m.id === desktopMode);
    setDesktopMode(modes[(idx + 1) % modes.length].id);
  }, [modes, desktopMode, setDesktopMode]);

  const toggleMcRef = useRef(() => setTaskBoardOpen((prev) => !prev));
  const openWindowRef = useRef(openWindow);
  openWindowRef.current = openWindow;

  useEffect(() => {
    const modeCommands = allModes().map((m) => ({
      id: `mode:${m.id}`,
      label: `Mode: ${m.label}`,
      group: "Actions" as const,
      keywords: ["mode", "layout", m.id, m.description],
      execute: () => setDesktopMode(m.id),
    }));

    register([
      {
        id: "action:toggle-mc",
        label: "Toggle Mission Control",
        group: "Actions",
        shortcut: "F3",
        keywords: ["tasks", "kanban", "dashboard"],
        execute: () => toggleMcRef.current(),
      },
      {
        id: "action:open-settings",
        label: "Open Settings",
        group: "Actions",
        shortcut: "Cmd+,",
        keywords: ["settings", "preferences", "config", "configure"],
        execute: () => setSettingsOpen((prev) => !prev),
      },
      ...modeCommands,
    ]);
    return () => unregister([
      "action:toggle-mc",
      "action:open-settings",
      ...allModes().map((m) => `mode:${m.id}`),
    ]);
  }, [register, unregister, allModes, setDesktopMode]);

  useEffect(() => {
    const appCommands = apps.map((app) => ({
      id: `app:${app.path}`,
      label: app.name,
      group: "Apps" as const,
      keywords: [app.path],
      execute: () => openWindowRef.current(app.name, app.path),
    }));
    if (appCommands.length > 0) register(appCommands);
    return () => unregister(apps.map((a) => `app:${a.path}`));
  }, [apps, register, unregister]);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative flex-1 flex flex-col md:flex-row">
        {/* Desktop dock -- hidden in ambient/conversational modes */}
        {modeConfig.showDock && <aside
          className={[
            "hidden md:flex items-center gap-2 bg-card/40 backdrop-blur-sm z-[55] transition-transform duration-200",
            isHorizontal ? "flex-row px-3 border-t border-border/40 order-last" : "flex-col py-3 border-border/40",
            dock.position === "left" && "border-r",
            dock.position === "right" && "border-l order-last",
            dock.autoHide && "group",
            dock.autoHide && dock.position === "left" && "-translate-x-full hover:translate-x-0",
            dock.autoHide && dock.position === "right" && "translate-x-full hover:translate-x-0",
            dock.autoHide && dock.position === "bottom" && "translate-y-full hover:translate-y-0",
          ].filter(Boolean).join(" ")}
          style={isHorizontal
            ? { width: "100%", height: dock.size }
            : { width: dock.size }
          }
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setTaskBoardOpen((prev) => !prev)}
                className={`flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
                  taskBoardOpen
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border/60"
                }`}
                style={{ width: dock.iconSize, height: dock.iconSize }}
              >
                <KanbanSquareIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side={tooltipSide} sideOffset={8}>
              Tasks
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleStore}
                className={`flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
                  storeOpen
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card border-border/60"
                }`}
                style={{ width: dock.iconSize, height: dock.iconSize }}
              >
                <StoreIcon className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side={tooltipSide} sideOffset={8}>
              App Store
            </TooltipContent>
          </Tooltip>

          {apps.filter((a) => pinnedApps.includes(a.path)).length > 0 && (
            <div className={isHorizontal ? "h-6 border-l border-border/40" : "w-6 border-t border-border/40"} />
          )}

          {apps.filter((a) => pinnedApps.includes(a.path)).map((app) => {
            const win = windows.find(
              (w) => w.path === app.path && !w.minimized,
            );
            return (
              <DockIcon
                key={app.path}
                name={app.name}
                active={!!win}
                onClick={() => openWindow(app.name, app.path)}
                iconSize={dock.iconSize}
                tooltipSide={tooltipSide}
                iconUrl={app.iconUrl}
                onUnpin={() => togglePin(app.path)}
                onRegenerateIcon={() => regenerateIcon(nameToSlug(app.name))}
              />
            );
          })}

          <div className={isHorizontal
            ? "ml-auto flex flex-row items-center gap-2"
            : "mt-auto flex flex-col items-center gap-2"
          }>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={cycleMode}
                  className="flex items-center justify-center rounded-xl bg-card border border-border/60 shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all"
                  style={{ width: dock.iconSize, height: dock.iconSize }}
                >
                  <MonitorIcon className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side={tooltipSide} sideOffset={8}>
                {modeConfig.label} mode
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setSettingsOpen((prev) => !prev)}
                  className={`flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
                    settingsOpen
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card border-border/60"
                  }`}
                  style={{ width: dock.iconSize, height: dock.iconSize }}
                >
                  <SettingsIcon className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side={tooltipSide} sideOffset={8}>
                Settings
              </TooltipContent>
            </Tooltip>
            <UserButton />
          </div>
        </aside>}

        {/* Mobile dock (bottom tab bar) */}
        {modeConfig.showDock && (
          <nav className="flex md:hidden items-center gap-1 px-2 py-1.5 border-t border-border/40 bg-card/80 backdrop-blur-sm order-last overflow-x-auto z-[55]">
            <button
              onClick={() => setTaskBoardOpen((prev) => !prev)}
              className={`flex shrink-0 size-9 items-center justify-center rounded-lg border transition-all active:scale-95 ${
                taskBoardOpen
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border/60"
              }`}
            >
              <KanbanSquareIcon className="size-4" />
            </button>
            <button
              onClick={onToggleStore}
              className={`flex shrink-0 size-9 items-center justify-center rounded-lg border transition-all active:scale-95 ${
                storeOpen
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border/60"
              }`}
            >
              <StoreIcon className="size-4" />
            </button>
            <button
              onClick={cycleMode}
              className="flex shrink-0 size-9 items-center justify-center rounded-lg border border-border/60 bg-card transition-all active:scale-95"
              title={`${modeConfig.label} mode`}
            >
              <MonitorIcon className="size-4" />
            </button>
            <button
              onClick={() => setSettingsOpen((prev) => !prev)}
              className={`flex shrink-0 size-9 items-center justify-center rounded-lg border transition-all active:scale-95 ${
                settingsOpen
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card border-border/60"
              }`}
              title="Settings"
            >
              <SettingsIcon className="size-4" />
            </button>
            <div className="shrink-0">
              <UserButton />
            </div>
            {apps.filter((a) => pinnedApps.includes(a.path)).map((app) => {
              const win = windows.find(
                (w) => w.path === app.path && !w.minimized,
              );
              return (
                <button
                  key={app.path}
                  onClick={() => openWindow(app.name, app.path)}
                  className={`flex shrink-0 h-9 items-center gap-1.5 px-3 rounded-lg border transition-all active:scale-95 ${
                    win
                      ? "bg-primary/10 border-primary/30 text-foreground"
                      : "bg-card border-border/60 text-muted-foreground"
                  }`}
                >
                  <span className="text-xs font-medium truncate max-w-[80px]">{app.name}</span>
                </button>
              );
            })}
          </nav>
        )}

        <div className="relative flex-1 min-h-0">
          {taskBoardOpen && (
            <MissionControl
              apps={apps}
              openWindows={new Set(windows.filter((w) => !w.minimized).map((w) => w.path))}
              onOpenApp={openWindow}
              onClose={() => setTaskBoardOpen(false)}
              pinnedApps={pinnedApps}
              onTogglePin={togglePin}
              onRegenerateIcon={regenerateIcon}
            />
          )}

          {!modeConfig.showWindows && modeConfig.id === "ambient" && (
            <AmbientClock onSwitchMode={cycleMode} />
          )}

          {!modeConfig.showWindows && modeConfig.id !== "ambient" && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <p className="text-sm text-muted-foreground mb-1">
                  {modeConfig.label} mode
                </p>
                <button
                  onClick={cycleMode}
                  className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  Switch mode
                </button>
              </div>
            </div>
          )}

          {modeConfig.showWindows && windows.filter((w) => !w.minimized).length === 0 &&
            apps.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  No apps running. Try &quot;Build me a notes app&quot; in
                  the chat.
                </p>
              </div>
            )}

          {/* Desktop: positioned windows; Mobile: full-screen cards */}
          {modeConfig.showWindows && windows.map((win) =>
            win.minimized ? null : (
              <Card
                key={win.id}
                className="app-window absolute gap-0 rounded-none md:rounded-lg p-0 overflow-hidden shadow-2xl"
                style={{
                  "--win-x": `${win.x}px`,
                  "--win-y": `${win.y}px`,
                  "--win-w": `${win.width}px`,
                  "--win-h": `${win.height}px`,
                  zIndex: win.zIndex,
                } as React.CSSProperties}
                onMouseDown={() => bringToFront(win.id)}
              >
                <CardHeader
                  className="flex flex-row items-center gap-0 px-3 py-2 border-b border-border md:cursor-grab md:active:cursor-grabbing select-none space-y-0"
                  onPointerDown={(e) => onDragStart(win.id, e)}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragEnd}
                >
                  <TrafficLights
                    onClose={() => closeWindow(win.id)}
                    onMinimize={() => minimizeWindow(win.id)}
                  />
                  <CardTitle className="text-xs font-medium truncate flex-1 text-center">
                    {win.title}
                  </CardTitle>
                  <div className="w-[54px] flex items-center justify-end">
                    <AIButton
                      appName={win.title}
                      appPath={win.path}
                    />
                  </div>
                </CardHeader>

                <CardContent className="relative flex-1 p-0 min-h-0">
                  <AppViewer path={win.path} />
                  {interacting && (
                    <div className="absolute inset-0 z-10" />
                  )}
                </CardContent>

                <div
                  className="hidden md:block absolute bottom-0 right-0 size-4 cursor-se-resize touch-none z-20"
                  onPointerDown={(e) => onResizeStart(win.id, e)}
                  onPointerMove={onResizeMove}
                  onPointerUp={onResizeEnd}
                >
                  <svg
                    viewBox="0 0 16 16"
                    className="size-4 text-muted-foreground/40"
                  >
                    <path
                      d="M14 2v12H2"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                    <path
                      d="M14 7v7H7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1"
                    />
                  </svg>
                </div>
              </Card>
            ),
          )}
        </div>
      </div>

      <Settings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </TooltipProvider>
  );
}
