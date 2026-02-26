"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { useWindowManager, type LayoutWindow } from "@/hooks/useWindowManager";
import { useCommandStore } from "@/stores/commands";
import { useDesktopMode, type DesktopMode } from "@/stores/desktop-mode";
import { useDesktopConfigStore } from "@/stores/desktop-config";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { AppViewer } from "./AppViewer";
import { AIButton } from "./AIButton";
import { MissionControl } from "./MissionControl";
import { Settings } from "./Settings";
import { CanvasRenderer } from "./canvas/CanvasRenderer";
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
import { KanbanSquareIcon, StoreIcon, MonitorIcon, SettingsIcon, PinOffIcon, RefreshCwIcon, CheckIcon } from "lucide-react";
import { UserButton } from "./UserButton";
import { AmbientClock } from "./AmbientClock";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

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
  icon?: string;
  version?: string;
}

function nameToSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 200;

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

function ModeSwitcher({
  iconSize,
  tooltipSide,
}: {
  iconSize: number;
  tooltipSide: "left" | "right" | "top";
}) {
  const [open, setOpen] = useState(false);
  const mode = useDesktopMode((s) => s.mode);
  const setMode = useDesktopMode((s) => s.setMode);
  const allModes = useDesktopMode((s) => s.allModes);
  const getModeConfig = useDesktopMode((s) => s.getModeConfig);
  const modeConfig = getModeConfig(mode);
  const modes = allModes();
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onClickOutside);
    return () => document.removeEventListener("pointerdown", onClickOutside);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`flex items-center justify-center rounded-xl border shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all ${
          open ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border/60"
        }`}
        style={{ width: iconSize, height: iconSize }}
        aria-label={`${modeConfig.label} mode`}
      >
        <MonitorIcon className="size-4" />
      </button>
      {open && (
        <div
          className={[
            "absolute flex flex-col min-w-[160px] py-1 rounded-lg bg-card border border-border shadow-xl z-[60]",
            tooltipSide === "right" && "left-full top-0 ml-2",
            tooltipSide === "left" && "right-full top-0 mr-2",
            tooltipSide === "top" && "bottom-full left-1/2 -translate-x-1/2 mb-2",
          ].filter(Boolean).join(" ")}
        >
          {modes.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                setMode(m.id);
                setOpen(false);
              }}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-muted ${
                mode === m.id ? "text-foreground font-medium" : "text-muted-foreground"
              }`}
            >
              {mode === m.id ? (
                <CheckIcon className="size-3 shrink-0" />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              <span>{m.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface DesktopProps {
  storeOpen?: boolean;
  onToggleStore?: () => void;
}

export function Desktop({ storeOpen, onToggleStore }: DesktopProps) {
  const windows = useWindowManager((s) => s.windows);
  const apps = useWindowManager((s) => s.apps);
  const wmOpenWindow = useWindowManager((s) => s.openWindow);
  const wmCloseWindow = useWindowManager((s) => s.closeWindow);
  const wmMinimizeWindow = useWindowManager((s) => s.minimizeWindow);
  const wmFocusWindow = useWindowManager((s) => s.focusWindow);
  const wmMoveWindow = useWindowManager((s) => s.moveWindow);
  const wmResizeWindow = useWindowManager((s) => s.resizeWindow);
  const wmGetWindow = useWindowManager((s) => s.getWindow);
  const wmSetApps = useWindowManager((s) => s.setApps);
  const wmSetWindows = useWindowManager((s) => s.setWindows);
  const wmLoadLayout = useWindowManager((s) => s.loadLayout);

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
        wmSetApps((prev) =>
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
              wmSetApps((prev) =>
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
  }, [wmSetApps]);

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
          wmSetApps((prev) =>
            prev.map((a) =>
              nameToSlug(a.name) === slug ? { ...a, iconUrl: bustUrl } : a,
            ),
          );
        });
      })
      .catch((err) => console.warn(`Icon regen request failed for "${slug}":`, err))
      .finally(() => generatingRef.current.delete(slug));
  }, [wmSetApps]);

  const addApp = useCallback((name: string, path: string, moduleIconUrl?: string) => {
    wmSetApps((prev) => {
      if (prev.find((a) => a.path === path)) return prev;
      return [...prev, { name, path, iconUrl: moduleIconUrl }];
    });
    if (!moduleIconUrl) {
      const slug = nameToSlug(name);
      checkAndGenerateIcon(slug);
    }
  }, [wmSetApps, checkAndGenerateIcon]);

  const openWindow = useCallback((name: string, path: string) => {
    wmOpenWindow(name, path, dockXOffset);
    // In canvas mode, reposition new windows to the center of the current viewport
    if (useDesktopMode.getState().mode === "canvas") {
      const { screenToCanvas } = useCanvasTransform.getState();
      const center = screenToCanvas(window.innerWidth / 2, window.innerHeight / 2);
      const win = useWindowManager.getState().windows.find((w) => w.path === path);
      if (win) {
        wmMoveWindow(win.id, center.x - win.width / 2, center.y - win.height / 2);
      }
    }
  }, [wmOpenWindow, dockXOffset, wmMoveWindow]);

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

      const layoutToLoad: LayoutWindow[] = [];

      for (const mod of registry) {
        if (mod.status !== "active") continue;

        try {
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

          const moduleIconUrl = meta.icon
            ? `${GATEWAY_URL}/files/modules/${mod.name}/${meta.icon}`
            : undefined;
          addApp(meta.name, path, moduleIconUrl);

          const saved = layoutMap.get(path);
          if (saved) {
            layoutToLoad.push(saved);
          } else {
            openWindow(meta.name, path);
          }
        } catch {
          // module.json missing or invalid, skip
        }
      }

      if (layoutToLoad.length > 0) {
        wmLoadLayout(layoutToLoad);
      }
    } catch {
      // modules.json not available yet
    }
  }, [addApp, openWindow, wmLoadLayout]);

  useEffect(() => {
    loadModules();
  }, [loadModules]);

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
            wmSetApps((prev) => prev.filter((a) => a.path !== path));
            wmSetWindows((prev) => prev.filter((w) => w.path !== path));
          } else {
            addApp(name, path);
            openWindow(name, path);
          }
        }
      },
      [loadModules, addApp, openWindow, wmSetApps, wmSetWindows],
    ),
  );

  const onDragStart = useCallback(
    (id: string, e: React.PointerEvent) => {
      e.preventDefault();
      const win = wmGetWindow(id);
      if (!win) return;
      dragRef.current = {
        id,
        startX: e.clientX,
        startY: e.clientY,
        origX: win.x,
        origY: win.y,
      };
      setInteracting(true);
      wmFocusWindow(id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [wmGetWindow, wmFocusWindow],
  );

  const onDragMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { id, startX, startY, origX, origY } = dragRef.current;
    wmMoveWindow(id, origX + (e.clientX - startX), origY + (e.clientY - startY));
  }, [wmMoveWindow]);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    setInteracting(false);
  }, []);

  const onResizeStart = useCallback(
    (id: string, e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const win = wmGetWindow(id);
      if (!win) return;
      resizeRef.current = {
        id,
        startX: e.clientX,
        startY: e.clientY,
        origW: win.width,
        origH: win.height,
      };
      setInteracting(true);
      wmFocusWindow(id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [wmGetWindow, wmFocusWindow],
  );

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const { id, startX, startY, origW, origH } = resizeRef.current;
    wmResizeWindow(
      id,
      Math.max(MIN_WIDTH, origW + (e.clientX - startX)),
      Math.max(MIN_HEIGHT, origH + (e.clientY - startY)),
    );
  }, [wmResizeWindow]);

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
            <ModeSwitcher iconSize={dock.iconSize} tooltipSide={tooltipSide} />
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
            <ModeSwitcher iconSize={36} tooltipSide="top" />
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

          {modeConfig.showWindows && desktopMode === "canvas" && (
            <CanvasRenderer />
          )}

          {modeConfig.showWindows && desktopMode !== "canvas" && windows.filter((w) => !w.minimized).length === 0 &&
            apps.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  No apps running. Try &quot;Build me a notes app&quot; in
                  the chat.
                </p>
              </div>
            )}

          {/* Desktop: positioned windows; Mobile: full-screen cards */}
          {modeConfig.showWindows && desktopMode !== "canvas" && windows.map((win) =>
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
                onMouseDown={() => wmFocusWindow(win.id)}
              >
                <CardHeader
                  className="flex flex-row items-center gap-0 px-3 py-2 border-b border-border md:cursor-grab md:active:cursor-grabbing select-none space-y-0"
                  onPointerDown={(e) => onDragStart(win.id, e)}
                  onPointerMove={onDragMove}
                  onPointerUp={onDragEnd}
                >
                  <TrafficLights
                    onClose={() => wmCloseWindow(win.id)}
                    onMinimize={() => wmMinimizeWindow(win.id)}
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
