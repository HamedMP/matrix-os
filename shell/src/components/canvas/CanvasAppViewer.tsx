"use client";

import React from "react";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { routeAppBridgeLaunch } from "@/lib/builtin-apps";
import { AppViewer } from "../AppViewer";
import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";

function openCanvasApp(name: string, requestedPath: string): void {
  routeAppBridgeLaunch(name, requestedPath, (title, path) => {
    // The store restores and focuses existing windows at this canonical path.
    useWindowManager.getState().openWindow(title, path, 0);
    requestAnimationFrame(() => {
      const win = useWindowManager.getState().windows.find((candidate) => candidate.path === path);
      if (!win || win.minimized) return;
      const canvas = useCanvasTransform.getState();
      canvas.focusOnWindow(
        win,
        canvas.containerRect?.width ?? window.innerWidth,
        canvas.containerRect?.height ?? window.innerHeight,
      );
    });
  });
}

/** Keep app bridge launches connected to the Canvas window and viewport stores. */
export function CanvasAppViewer({ path, sharedAppTarget, active = true }: {
  path: string;
  sharedAppTarget?: CollaborativeAppDirectoryItem;
  active?: boolean;
}) {
  return <AppViewer path={path} sharedAppTarget={sharedAppTarget} active={active} onOpenApp={openCanvasApp} />;
}
