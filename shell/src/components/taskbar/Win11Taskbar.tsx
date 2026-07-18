"use client";

import { useRef, useState } from "react";
import {
  BatteryMediumIcon,
  ChevronUpIcon,
  SearchIcon,
  Volume2Icon,
  WifiIcon,
} from "lucide-react";
import type { AppWindow } from "@/hooks/useWindowManager";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  TaskbarAppIcon,
  TaskbarClock,
  Win11Logo,
} from "./taskbar-shared";
import {
  baseWindowPath,
  resolveBuiltInStartApps,
  useStartMenuDismiss,
  type TaskbarAppEntry,
} from "./taskbar-utils";
import { Win11StartMenu } from "./Win11StartMenu";
import type { WindowsTaskbarProps } from "./WindowsTaskbar";

interface CenterIcon extends TaskbarAppEntry {
  open: boolean;
}

/**
 * Windows 11 taskbar: 48px acrylic bar fixed to the bottom with a
 * center-aligned icon group (Start, Search, pinned/open apps with underline
 * pill indicators) and a right tray (hidden-icons caret, network/volume/
 * battery, two-line clock, notification dot).
 */
export function Win11Taskbar({
  apps,
  windows,
  onOpenApp,
  onFocusWindow,
  onMinimizeWindow,
  onOpenSettings,
  onOpenCommandPalette,
  children,
}: WindowsTaskbarProps) {
  const [startOpen, setStartOpen] = useState(false);
  const taskbarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useStartMenuDismiss(startOpen, () => setStartOpen(false), taskbarRef, menuRef);

  const focusedWindow = windows.reduce<AppWindow | undefined>(
    (best, w) => (!w.minimized && (best === undefined || w.zIndex > best.zIndex) ? w : best),
    undefined,
  );
  const focusedBasePath = focusedWindow ? baseWindowPath(focusedWindow.path) : null;

  // Center icons: built-ins stand in for pinned apps; any app with an open
  // window joins the row (deduped by base path), like the real Win11 taskbar.
  const openBasePaths = new Set(windows.map((w) => baseWindowPath(w.path)));
  const centerIcons: CenterIcon[] = [];
  const seenPaths = new Set<string>();
  for (const app of resolveBuiltInStartApps(apps)) {
    centerIcons.push({ ...app, open: openBasePaths.has(app.path) });
    seenPaths.add(app.path);
  }
  for (const app of apps) {
    const base = baseWindowPath(app.path);
    if (seenPaths.has(base) || !openBasePaths.has(base)) continue;
    seenPaths.add(base);
    centerIcons.push({ name: app.name, path: app.path, iconUrl: app.iconUrl, open: true });
  }

  const onCenterIconClick = (icon: CenterIcon) => {
    const win = windows
      .filter((w) => baseWindowPath(w.path) === icon.path)
      .toSorted((a, b) => b.zIndex - a.zIndex)[0];
    if (!win) {
      onOpenApp(icon.path, icon.name);
      return;
    }
    if (win.minimized) {
      onFocusWindow(win.id);
      return;
    }
    if (focusedWindow?.id === win.id) {
      onMinimizeWindow(win.id);
      return;
    }
    onFocusWindow(win.id);
  };

  return (
    <>
      <div
        ref={taskbarRef}
        data-win11-taskbar
        className="win11-taskbar"
        style={{ zIndex: SHELL_Z_INDEX.taskbar }}
      >
        <div className="win11-taskbar-center">
          <button
            type="button"
            className="win11-taskbar-icon-button"
            aria-label="Start"
            aria-expanded={startOpen}
            onClick={() => setStartOpen((open) => !open)}
          >
            <Win11Logo />
          </button>
          <button
            type="button"
            className="win11-taskbar-icon-button"
            aria-label="Search"
            onClick={() => setStartOpen(true)}
          >
            <SearchIcon className="win11-taskbar-glyph" aria-hidden="true" />
          </button>
          {centerIcons.map((icon) => (
            <button
              key={icon.path}
              type="button"
              className="win11-taskbar-icon-button"
              data-focused={focusedBasePath === icon.path || undefined}
              title={icon.name}
              aria-label={icon.name}
              onClick={() => onCenterIconClick(icon)}
            >
              <TaskbarAppIcon name={icon.name} iconUrl={icon.iconUrl} size={24} />
              {icon.open ? <span className="win11-task-pill" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <div className="win11-tray">
          {children ? <div className="win11-taskbar-toolbar">{children}</div> : null}
          <button type="button" className="win11-tray-button" aria-label="Show hidden icons">
            <ChevronUpIcon aria-hidden="true" />
          </button>
          <button type="button" className="win11-tray-button" aria-label="Network, volume and battery">
            <WifiIcon aria-hidden="true" />
            <Volume2Icon aria-hidden="true" />
            <BatteryMediumIcon aria-hidden="true" />
          </button>
          <button type="button" className="win11-tray-button win11-tray-clock-button" aria-label="Date and time">
            <TaskbarClock variant="win11" />
          </button>
          <span className="win11-notification-dot" aria-hidden="true" />
        </div>
      </div>
      {startOpen ? (
        <Win11StartMenu
          ref={menuRef}
          apps={apps}
          onOpenApp={(path, name) => {
            setStartOpen(false);
            onOpenApp(path, name);
          }}
          onClose={() => setStartOpen(false)}
        />
      ) : null}
    </>
  );
}
