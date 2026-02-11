"use client";

import { useState, useCallback } from "react";
import { useFileWatcher } from "@/hooks/useFileWatcher";

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

interface AppViewerProps {
  path: string;
}

export function AppViewer({ path }: AppViewerProps) {
  const [refreshKey, setRefreshKey] = useState(0);

  useFileWatcher(
    useCallback(
      (changedPath: string, event: string) => {
        if (changedPath === path && event === "change") {
          setRefreshKey((k) => k + 1);
        }
      },
      [path],
    ),
  );

  return (
    <iframe
      key={refreshKey}
      src={`${GATEWAY_URL}/files/${path}`}
      className="h-full w-full border-0"
      sandbox="allow-scripts allow-forms allow-popups"
      title={path}
    />
  );
}
