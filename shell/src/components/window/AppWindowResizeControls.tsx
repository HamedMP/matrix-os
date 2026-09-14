"use client";

import { WindowResizeControls } from "@matrix-os/ui";
import { getEffectiveMinimumWindowSize, useWindowManager, type AppWindow } from "@/hooks/useWindowManager";

export function AppWindowResizeControls({ win, scale, onInteractionChange, className }: {
  win: AppWindow;
  scale?: number;
  onInteractionChange: (active: boolean) => void;
  className?: string;
}) {
  const resizeWindow = useWindowManager((state) => state.resizeWindow);
  const focusWindow = useWindowManager((state) => state.focusWindow);
  return <WindowResizeControls bounds={win} minimum={getEffectiveMinimumWindowSize(win.path)}
    scale={scale} className={className} onInteractionChange={onInteractionChange}
    onFocus={() => focusWindow(win.id)}
    onBoundsChange={(bounds) => resizeWindow(win.id, bounds.width, bounds.height, bounds)} />;
}
