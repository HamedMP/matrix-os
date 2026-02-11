"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { AppViewer } from "./AppViewer";
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

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

const DOCK_WIDTH = 56;

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

interface AppEntry {
  name: string;
  path: string;
}

interface ModuleRegistryEntry {
  name: string;
  type: string;
  path: string;
  status: string;
}

interface ModuleMeta {
  name: string;
  entry: string;
  version?: string;
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
}: {
  name: string;
  active: boolean;
  onClick: () => void;
}) {
  const initial = name.charAt(0).toUpperCase();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className="relative flex size-10 items-center justify-center rounded-xl bg-card border border-border/60 shadow-sm hover:shadow-md hover:scale-105 active:scale-95 transition-all"
        >
          <span className="text-sm font-semibold text-foreground">
            {initial}
          </span>
          {active && (
            <span className="absolute -right-1 top-1/2 -translate-y-1/2 size-1.5 rounded-full bg-foreground" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {name}
      </TooltipContent>
    </Tooltip>
  );
}

export function Desktop() {
  const [windows, setWindows] = useState<AppWindow[]>([]);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [interacting, setInteracting] = useState(false);

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

  const addApp = useCallback((name: string, path: string) => {
    setApps((prev) => {
      if (prev.find((a) => a.path === path)) return prev;
      return [...prev, { name, path }];
    });
  }, []);

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
          x: DOCK_WIDTH + 20 + prev.length * 30,
          y: 20 + prev.length * 30,
          width: 640,
          height: 480,
          minimized: false,
          zIndex: nextZ++,
        },
      ];
    });
  }, []);

  const loadModules = useCallback(async () => {
    try {
      const res = await fetch(
        `${GATEWAY_URL}/files/system/modules.json`,
      );
      if (!res.ok) return;
      const registry: ModuleRegistryEntry[] = await res.json();

      for (const mod of registry) {
        if (mod.status !== "active") continue;

        try {
          const metaRes = await fetch(
            `${GATEWAY_URL}/files/modules/${mod.name}/module.json`,
          );
          if (!metaRes.ok) continue;
          const meta: ModuleMeta = await metaRes.json();
          const path = `modules/${mod.name}/${meta.entry}`;

          addApp(meta.name, path);
          openWindow(meta.name, path);
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
    setWindows((prev) => prev.filter((w) => w.id !== id));
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

  return (
    <TooltipProvider delayDuration={300}>
      <div className="relative flex-1 flex">
        {apps.length > 0 && (
          <aside
            className="flex flex-col items-center gap-2 py-3 border-r border-border/40 bg-card/40 backdrop-blur-sm"
            style={{ width: DOCK_WIDTH }}
          >
            {apps.map((app) => {
              const win = windows.find(
                (w) => w.path === app.path && !w.minimized,
              );
              return (
                <DockIcon
                  key={app.path}
                  name={app.name}
                  active={!!win}
                  onClick={() => openWindow(app.name, app.path)}
                />
              );
            })}
          </aside>
        )}

        <div className="relative flex-1">
          {windows.filter((w) => !w.minimized).length === 0 &&
            apps.length === 0 && (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">
                  No apps running. Try &quot;Build me a notes app&quot; in
                  the chat.
                </p>
              </div>
            )}

          {windows.map((win) =>
            win.minimized ? null : (
              <Card
                key={win.id}
                className="absolute gap-0 rounded-lg p-0 overflow-hidden shadow-2xl"
                style={{
                  left: win.x,
                  top: win.y,
                  width: win.width,
                  height: win.height,
                  zIndex: win.zIndex,
                }}
                onMouseDown={() => bringToFront(win.id)}
              >
                <CardHeader
                  className="flex-row items-center gap-0 px-3 py-2 border-b border-border cursor-grab active:cursor-grabbing select-none space-y-0"
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
                  <div className="w-[54px]" />
                </CardHeader>

                <CardContent className="relative flex-1 p-0 min-h-0">
                  <AppViewer path={win.path} />
                  {interacting && (
                    <div className="absolute inset-0 z-10" />
                  )}
                </CardContent>

                <div
                  className="absolute bottom-0 right-0 size-4 cursor-se-resize touch-none z-20"
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
    </TooltipProvider>
  );
}
