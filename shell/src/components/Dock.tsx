"use client";

import { useState, useCallback } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";
import { Button } from "@/components/ui/button";

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
    <nav className="fixed bottom-4 left-1/2 -translate-x-1/2 flex gap-2 rounded-xl border border-border bg-card/80 px-3 py-2 backdrop-blur-sm">
      {apps.map((app) => (
        <Button key={app.path} size="sm" title={app.name}>
          {app.name}
        </Button>
      ))}
    </nav>
  );
}
