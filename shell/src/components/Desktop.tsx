"use client";

import { useState, useCallback } from "react";
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

let nextZ = 1;

export function Desktop() {
  const [windows, setWindows] = useState<AppWindow[]>([]);

  useFileWatcher(
    useCallback((path: string, event: string) => {
      if (!path.startsWith("apps/") || event === "unlink") return;

      const name = path.replace("apps/", "").replace(".html", "");

      setWindows((prev) => {
        const existing = prev.find((w) => w.path === path);
        if (existing) return prev;

        return [
          ...prev,
          {
            id: `win-${Date.now()}`,
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
    }, []),
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

  return (
    <div className="relative flex-1 bg-background">
      {windows.length === 0 && (
        <div className="flex h-full items-center justify-center">
          <p className="text-sm text-muted-foreground">
            No apps running. Try &quot;Build me a notes app&quot; in the chat.
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
            <CardHeader className="flex-row items-center gap-0 px-3 py-2 border-b border-border cursor-move select-none space-y-0">
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

            <CardContent className="flex-1 p-0 min-h-0">
              <AppViewer path={win.path} />
            </CardContent>
          </Card>
        ),
      )}
    </div>
  );
}
