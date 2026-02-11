"use client";

import { useState, useCallback } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { AppViewer } from "./AppViewer";

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
    <div className="relative flex-1" style={{ background: "var(--color-bg)" }}>
      {windows.length === 0 && (
        <div className="flex h-full items-center justify-center">
          <p
            className="text-sm"
            style={{ color: "var(--color-muted)" }}
          >
            No apps running. Try &quot;Build me a notes app&quot; in the chat.
          </p>
        </div>
      )}

      {windows.map((win) =>
        win.minimized ? null : (
          <div
            key={win.id}
            className="absolute rounded-lg border overflow-hidden shadow-2xl"
            style={{
              left: win.x,
              top: win.y,
              width: win.width,
              height: win.height,
              zIndex: win.zIndex,
              borderColor: "var(--color-border)",
              background: "var(--color-surface)",
            }}
            onMouseDown={() => bringToFront(win.id)}
          >
            <div
              className="flex items-center justify-between px-3 py-2 cursor-move border-b select-none"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface)",
              }}
            >
              <span className="text-xs font-medium truncate">
                {win.title}
              </span>
              <div className="flex gap-1.5">
                <button
                  onClick={() => toggleMinimize(win.id)}
                  className="h-3 w-3 rounded-full"
                  style={{ background: "var(--color-warning)" }}
                />
                <button
                  onClick={() => closeWindow(win.id)}
                  className="h-3 w-3 rounded-full"
                  style={{ background: "var(--color-error)" }}
                />
              </div>
            </div>

            <AppViewer path={win.path} />
          </div>
        ),
      )}
    </div>
  );
}
