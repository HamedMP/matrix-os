"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { AppViewer } from "./AppViewer";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardAction,
  CardContent,
} from "@/components/ui/card";
import { LayoutGridIcon } from "lucide-react";

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

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
          x: 40 + prev.length * 30,
          y: 40 + prev.length * 30,
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

  const toggleMinimize = useCallback((id: string) => {
    setWindows((prev) =>
      prev.map((w) =>
        w.id === id ? { ...w, minimized: !w.minimized } : w,
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

  const visibleWindows = windows.filter((w) => !w.minimized);

  return (
    <div className="relative flex-1">
      {visibleWindows.length === 0 && apps.length === 0 && (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-muted-foreground">
            No apps running. Try &quot;Build me a notes app&quot; in the
            chat.
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
              <CardTitle className="text-xs font-medium truncate">
                {win.title}
              </CardTitle>
              <CardAction className="flex gap-1.5 self-center">
                <Button
                  onClick={() => toggleMinimize(win.id)}
                  variant="ghost"
                  className="size-3 rounded-full bg-warning p-0 hover:bg-warning/80"
                  aria-label="Minimize"
                />
                <Button
                  onClick={() => closeWindow(win.id)}
                  variant="ghost"
                  className="size-3 rounded-full bg-destructive p-0 hover:bg-destructive/80"
                  aria-label="Close"
                />
              </CardAction>
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

      {apps.length > 0 && (
        <nav className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50 flex gap-1.5 rounded-xl border border-border bg-card/80 px-3 py-2 backdrop-blur-sm">
          {apps.map((app) => {
            const win = windows.find((w) => w.path === app.path);
            const isOpen = win && !win.minimized;

            return (
              <Button
                key={app.path}
                variant={isOpen ? "default" : "ghost"}
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => openWindow(app.name, app.path)}
              >
                <LayoutGridIcon className="size-3" />
                {app.name}
              </Button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
