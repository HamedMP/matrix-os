"use client";

import { useState, type Ref } from "react";
import {
  ChevronRightIcon,
  CircleHelpIcon,
  FolderOpenIcon,
  KeyRoundIcon,
  MonitorIcon,
  PowerIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { AppEntry } from "@/hooks/useWindowManager";
import { isBuiltInAppPath } from "@/lib/builtin-apps";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { useOsSessionStore } from "../os-session/os-session-store";
import { StartMenuUser, TaskbarAppIcon } from "./taskbar-shared";
import { resolveBuiltInStartApps } from "./taskbar-utils";

export interface XpStartMenuProps {
  ref?: Ref<HTMLDivElement>;
  apps: AppEntry[];
  onOpenApp: (path: string, name?: string) => void;
  onOpenSettings: () => void;
  onOpenCommandPalette: () => void;
  onClose: () => void;
}

/**
 * Authentic Windows XP (Luna) start menu: blue header band with the user
 * identity, a white left column of programs, a light-blue right column of
 * system places, and a footer band with Log Off / Turn Off Computer. The
 * footer actions close the menu and open the XP session overlays (log-off /
 * shutdown simulation) via the os-session store.
 */
export function XpStartMenu({
  ref,
  apps,
  onOpenApp,
  onOpenSettings,
  onOpenCommandPalette,
  onClose,
}: XpStartMenuProps) {
  const [allProgramsOpen, setAllProgramsOpen] = useState(false);
  const userApps = apps.filter((a) => !isBuiltInAppPath(a.path));
  const featuredApps = userApps.slice(0, 4);
  const builtIns = resolveBuiltInStartApps(apps);

  return (
    <div
      ref={ref}
      data-xp-start-menu
      className="xp-start-menu"
      style={{ zIndex: SHELL_Z_INDEX.taskbar }}
    >
      <div className="xp-start-header">
        <StartMenuUser avatarSize={40} className="xp-start-user" />
      </div>
      <div className="xp-start-body">
        <div className="xp-start-left">
          {allProgramsOpen ? (
            <div className="xp-all-programs" data-xp-all-programs>
              {builtIns.map((app) => (
                <button
                  key={app.path}
                  type="button"
                  className="xp-menu-item"
                  onClick={() => onOpenApp(app.path, app.name)}
                >
                  <TaskbarAppIcon name={app.name} iconUrl={app.iconUrl} size={24} />
                  <span className="xp-menu-item-label">{app.name}</span>
                </button>
              ))}
              {userApps.map((app) => (
                <button
                  key={app.path}
                  type="button"
                  className="xp-menu-item"
                  onClick={() => onOpenApp(app.path, app.name)}
                >
                  <TaskbarAppIcon name={app.name} iconUrl={app.iconUrl} size={24} />
                  <span className="xp-menu-item-label">{app.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="xp-pinned-programs">
              {builtIns.map((app) => (
                <button
                  key={app.path}
                  type="button"
                  className="xp-menu-item xp-menu-item-primary"
                  onClick={() => onOpenApp(app.path, app.name)}
                >
                  <TaskbarAppIcon name={app.name} iconUrl={app.iconUrl} size={30} />
                  <span className="xp-menu-item-label">{app.name}</span>
                </button>
              ))}
              {featuredApps.length > 0 ? <div className="xp-menu-separator" aria-hidden="true" /> : null}
              {featuredApps.map((app) => (
                <button
                  key={app.path}
                  type="button"
                  className="xp-menu-item"
                  onClick={() => onOpenApp(app.path, app.name)}
                >
                  <TaskbarAppIcon name={app.name} iconUrl={app.iconUrl} size={30} />
                  <span className="xp-menu-item-label">{app.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="xp-all-programs-row">
            <button
              type="button"
              className="xp-menu-item xp-all-programs-button"
              aria-expanded={allProgramsOpen}
              onClick={() => setAllProgramsOpen((open) => !open)}
            >
              <span>All Programs</span>
              <ChevronRightIcon className="xp-all-programs-arrow" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="xp-start-right">
          <button
            type="button"
            className="xp-menu-item xp-menu-item-place"
            onClick={() => onOpenApp("__file-browser__", "Files")}
          >
            <FolderOpenIcon aria-hidden="true" />
            <span className="xp-menu-item-label">My Documents</span>
          </button>
          <button
            type="button"
            className="xp-menu-item xp-menu-item-place"
            onClick={() => onOpenApp("__file-browser__", "Files")}
          >
            <MonitorIcon aria-hidden="true" />
            <span className="xp-menu-item-label">My Computer</span>
          </button>
          <div className="xp-menu-separator" aria-hidden="true" />
          <button type="button" className="xp-menu-item" onClick={onOpenSettings}>
            <SlidersHorizontalIcon aria-hidden="true" />
            <span className="xp-menu-item-label">Control Panel</span>
          </button>
          <button type="button" className="xp-menu-item" onClick={onOpenCommandPalette}>
            <CircleHelpIcon aria-hidden="true" />
            <span className="xp-menu-item-label">Help and Support</span>
          </button>
        </div>
      </div>
      <div className="xp-start-footer">
        <button
          type="button"
          className="xp-footer-button"
          aria-label="Log Off"
          onClick={() => {
            onClose();
            useOsSessionStore.getState().openXpLogoff();
          }}
        >
          <span className="xp-footer-chip xp-footer-chip-logoff" aria-hidden="true">
            <KeyRoundIcon />
          </span>
          <span>Log Off</span>
        </button>
        <button
          type="button"
          className="xp-footer-button"
          aria-label="Turn Off Computer"
          onClick={() => {
            onClose();
            useOsSessionStore.getState().openXpShutdown();
          }}
        >
          <span className="xp-footer-chip xp-footer-chip-power" aria-hidden="true">
            <PowerIcon />
          </span>
          <span>Turn Off Computer</span>
        </button>
      </div>
    </div>
  );
}
