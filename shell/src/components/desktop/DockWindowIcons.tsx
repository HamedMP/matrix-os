"use client";

import type { AppEntry, AppWindow } from "@/hooks/useWindowManager";
import { windowAppEntry } from "@/lib/window-app-entry";
import { DockIcon } from "./DockIcon";

type TooltipSide = "left" | "right" | "top" | "bottom";

interface DockWindowIconsProps {
  windows: AppWindow[];
  apps: AppEntry[];
  iconSize: number;
  tooltipSide: TooltipSide;
  isHorizontal: boolean;
  onActivate: (windowId: string) => void;
}

const rowClass = (isHorizontal: boolean) => (isHorizontal
  ? "flex flex-row items-center gap-1"
  : "flex flex-col items-center gap-1");

/**
 * Visible shared-app windows. They are not in the recipient's app catalog, so the catalog
 * section cannot show them; each keeps the owner's name and artwork from its own target.
 */
export function DockSharedAppWindows({ windows, apps, iconSize, tooltipSide, isHorizontal, onActivate, onClose }: DockWindowIconsProps & {
  onClose: (windowId: string) => void;
}) {
  const running = windows.filter((windowRecord) => windowRecord.sharedAppTarget && !windowRecord.minimized);
  if (running.length === 0) return null;
  return (
    <div data-dock-section="shared" className={rowClass(isHorizontal)} style={{ order: 2 }}>
      {running.map((windowRecord) => {
        const app = windowAppEntry(windowRecord, apps);
        return (
          <DockIcon
            key={windowRecord.id}
            name={windowRecord.title}
            active
            shared
            onClick={() => onActivate(windowRecord.id)}
            iconSize={iconSize}
            tooltipSide={tooltipSide}
            iconUrl={app.iconUrl}
            onQuit={() => onClose(windowRecord.id)}
            canQuit
          />
        );
      })}
    </div>
  );
}

/** Minimized windows, each a restore target that keeps the artwork of the app it belongs to. */
export function DockMinimizedWindows({ windows, apps, iconSize, tooltipSide, isHorizontal, onActivate }: DockWindowIconsProps) {
  const minimizedWindows = windows.filter((windowRecord) => windowRecord.minimized);
  if (minimizedWindows.length === 0) return null;
  return (
    <div data-dock-section="minimized" className={rowClass(isHorizontal)} style={{ order: 2 }}>
      <div
        className={isHorizontal ? "h-6 border-l border-border/40" : "w-6 border-t border-border/40"}
        style={{ animation: "dock-sep-in 300ms ease-out both" }}
      />
      {minimizedWindows.map((windowRecord, index) => (
        <div
          key={`min-${windowRecord.id}`}
          style={{ animation: `dock-icon-in 400ms cubic-bezier(0.34, 1.56, 0.64, 1) ${100 + index * 60}ms both` }}
        >
          <DockIcon
            name={windowRecord.title}
            active={false}
            shared={Boolean(windowRecord.sharedAppTarget)}
            onClick={() => onActivate(windowRecord.id)}
            iconSize={Math.round(iconSize * 0.8)}
            tooltipSide={tooltipSide}
            iconUrl={windowAppEntry(windowRecord, apps).iconUrl}
          />
        </div>
      ))}
    </div>
  );
}
