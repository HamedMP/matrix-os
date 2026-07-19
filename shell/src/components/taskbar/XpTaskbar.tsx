"use client";

import { useRef, useState } from "react";
import { Volume2Icon, WifiIcon } from "lucide-react";
import type { AppWindow } from "@/hooks/useWindowManager";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  TaskbarAppIcon,
  TaskbarClock,
  XpFlagLogo,
} from "./taskbar-shared";
import {
  baseWindowPath,
  resolveBuiltInStartApps,
  useStartMenuDismiss,
} from "./taskbar-utils";
import { XpStartMenu } from "./XpStartMenu";
import type { WindowsTaskbarProps } from "./WindowsTaskbar";

/**
 * Windows XP taskbar: 30px Luna-blue bar fixed to the bottom — green Start
 * button, quick-launch shortcuts, beveled task buttons for open windows, and
 * an inset system tray with clock.
 */
export function XpTaskbar({
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
  const appIconByPath = new Map(apps.map((a) => [a.path, a.iconUrl]));
  const iconForWindow = (winPath: string) =>
    appIconByPath.get(baseWindowPath(winPath)) ?? appIconByPath.get(winPath);
  const quickLaunchApps = resolveBuiltInStartApps(apps);

  const onTaskButtonClick = (win: AppWindow) => {
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
        data-xp-taskbar
        className="xp-taskbar"
        style={{ zIndex: SHELL_Z_INDEX.taskbar }}
      >
        <button
          type="button"
          className="xp-start-button"
          aria-label="Start"
          aria-expanded={startOpen}
          onClick={() => setStartOpen((open) => !open)}
        >
          <XpFlagLogo />
          <span className="xp-start-text">start</span>
        </button>
        <div className="xp-quick-launch">
          {quickLaunchApps.map((app) => (
            <button
              key={app.path}
              type="button"
              className="xp-quick-launch-button"
              title={app.name}
              aria-label={`Quick launch ${app.name}`}
              onClick={() => onOpenApp(app.path, app.name)}
            >
              <TaskbarAppIcon name={app.name} iconUrl={app.iconUrl} size={16} />
            </button>
          ))}
        </div>
        <div className="xp-task-buttons">
          {windows.map((win) => (
            <button
              key={win.id}
              type="button"
              data-xp-task-button
              data-active={focusedWindow?.id === win.id || undefined}
              className="xp-task-button"
              title={win.title}
              aria-pressed={focusedWindow?.id === win.id}
              onClick={() => onTaskButtonClick(win)}
            >
              <TaskbarAppIcon name={win.title} iconUrl={iconForWindow(win.path)} size={16} />
              <span className="xp-task-button-label">{win.title}</span>
            </button>
          ))}
        </div>
        {children ? <div className="xp-taskbar-toolbar">{children}</div> : null}
        <div className="xp-tray">
          <Volume2Icon className="xp-tray-icon" aria-hidden="true" />
          <WifiIcon className="xp-tray-icon" aria-hidden="true" />
          <TaskbarClock variant="xp" />
        </div>
      </div>
      {startOpen ? (
        <XpStartMenu
          ref={menuRef}
          apps={apps}
          onOpenApp={(path, name) => {
            setStartOpen(false);
            onOpenApp(path, name);
          }}
          onOpenSettings={() => {
            setStartOpen(false);
            onOpenSettings();
          }}
          onOpenCommandPalette={() => {
            setStartOpen(false);
            onOpenCommandPalette();
          }}
          onClose={() => setStartOpen(false)}
        />
      ) : null}
    </>
  );
}
