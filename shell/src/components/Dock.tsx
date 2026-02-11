"use client";

import { useState, useCallback } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";

interface DockItem {
  name: string;
  path: string;
}

export function Dock() {
  const [apps, setApps] = useState<DockItem[]>([]);

  useFileWatcher(
    useCallback((path: string, event: string) => {
      if (!path.startsWith("apps/")) return;

      const name = path.replace("apps/", "").replace(".html", "");

      if (event === "add") {
        setApps((prev) => {
          if (prev.some((a) => a.path === path)) return prev;
          return [...prev, { name, path }];
        });
      } else if (event === "unlink") {
        setApps((prev) => prev.filter((a) => a.path !== path));
      }
    }, []),
  );

  if (apps.length === 0) return null;

  return (
    <nav
      className="fixed bottom-4 left-1/2 -translate-x-1/2 flex gap-2 rounded-xl border px-3 py-2 backdrop-blur-sm"
      style={{
        borderColor: "var(--color-border)",
        background: "color-mix(in srgb, var(--color-surface) 80%, transparent)",
      }}
    >
      {apps.map((app) => (
        <button
          key={app.path}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-80"
          style={{ background: "var(--color-accent)", color: "#fff" }}
          title={app.name}
        >
          {app.name}
        </button>
      ))}
    </nav>
  );
}
