"use client";

import { useEffect, useRef, useState, type Ref } from "react";
import { LockIcon, LogOutIcon, PowerIcon, SearchIcon } from "lucide-react";
import type { AppEntry } from "@/hooks/useWindowManager";
import { isBuiltInAppPath } from "@/lib/builtin-apps";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { useOsSessionStore } from "../os-session/os-session-store";
import { StartMenuUser, TaskbarAppIcon } from "./taskbar-shared";
import {
  resolveBuiltInStartApps,
  type TaskbarAppEntry,
} from "./taskbar-utils";

export interface Win11StartMenuProps {
  ref?: Ref<HTMLDivElement>;
  apps: AppEntry[];
  onOpenApp: (path: string, name?: string) => void;
  /** Opens shell Settings (the Win11 design hides the mac MenuBar, so the
      start menu is the only pointer path to it). */
  onOpenSettings: () => void;
  onClose: () => void;
}

const MAX_PINNED_TILES = 18;
const MAX_RECOMMENDED = 3;

/**
 * Windows 11 start menu: centered acrylic panel with a live-filtering search
 * field, a 6-column Pinned grid (built-ins first), a Recommended section with
 * the most recent apps, and a footer with the user identity plus a power
 * button that opens a Lock / Sign out flyout (session simulation via the
 * os-session store).
 */
export function Win11StartMenu({ ref, apps, onOpenApp, onOpenSettings, onClose }: Win11StartMenuProps) {
  const [query, setQuery] = useState("");
  const [powerOpen, setPowerOpen] = useState(false);
  const powerWrapRef = useRef<HTMLDivElement>(null);
  const powerButtonRef = useRef<HTMLButtonElement>(null);

  // ARIA menu pattern for the power flyout: focus the first item on open,
  // arrow keys move between items, Escape closes and re-focuses the trigger.
  useEffect(() => {
    if (!powerOpen) return;
    powerWrapRef.current
      ?.querySelector<HTMLButtonElement>(".win11-power-flyout-item")
      ?.focus();
  }, [powerOpen]);

  const onFlyoutKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setPowerOpen(false);
      powerButtonRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(
      powerWrapRef.current?.querySelectorAll<HTMLButtonElement>(".win11-power-flyout-item") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % items.length
        : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const openLockScreen = () => {
    onClose();
    useOsSessionStore.getState().openWin11Lock();
  };

  const pinnedApps: TaskbarAppEntry[] = [];
  const pinnedPaths = new Set<string>();
  for (const app of resolveBuiltInStartApps(apps)) {
    pinnedApps.push(app);
    pinnedPaths.add(app.path);
  }
  for (const app of apps) {
    if (isBuiltInAppPath(app.path) || pinnedPaths.has(app.path)) continue;
    pinnedPaths.add(app.path);
    pinnedApps.push(app);
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleApps = normalizedQuery
    ? pinnedApps.filter((app) => app.name.toLowerCase().includes(normalizedQuery))
    : pinnedApps.slice(0, MAX_PINNED_TILES);
  const recommendedApps = apps.filter((a) => !isBuiltInAppPath(a.path)).slice(-MAX_RECOMMENDED).reverse();

  return (
    <div
      ref={ref}
      data-win11-start-menu
      className="win11-start-menu"
      style={{ zIndex: SHELL_Z_INDEX.taskbar }}
    >
      <div className="win11-start-search">
        <SearchIcon aria-hidden="true" />
        <input
          // eslint-disable-next-line jsx-a11y/no-autofocus, react-doctor/no-autofocus -- mirrors the real Windows 11 start menu: it opens with the search box focused so typing filters immediately
          autoFocus
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type here to search"
          aria-label="Search apps"
        />
      </div>
      <div className="win11-start-section-header">
        <span>{normalizedQuery ? "Search results" : "Pinned"}</span>
      </div>
      <div className="win11-start-grid">
        {visibleApps.map((app) => (
          <button
            key={app.path}
            type="button"
            className="win11-start-tile"
            onClick={() => onOpenApp(app.path, app.name)}
          >
            <TaskbarAppIcon name={app.name} iconUrl={app.iconUrl} size={32} />
            <span className="win11-start-tile-name">{app.name}</span>
          </button>
        ))}
        {visibleApps.length === 0 ? (
          <div className="win11-start-empty">No results found</div>
        ) : null}
      </div>
      {!normalizedQuery && recommendedApps.length > 0 ? (
        <>
          <div className="win11-start-section-header">
            <span>Recommended</span>
          </div>
          <div className="win11-start-recommended">
            {recommendedApps.map((app) => (
              <button
                key={app.path}
                type="button"
                className="win11-start-rec-item"
                onClick={() => onOpenApp(app.path, app.name)}
              >
                <TaskbarAppIcon name={app.name} iconUrl={app.iconUrl} size={24} />
                <span className="win11-start-rec-text">
                  <span className="win11-start-rec-name">{app.name}</span>
                  <span className="win11-start-rec-caption">Recently added</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
      <div className="win11-start-footer">
        <button
          type="button"
          className="win11-start-user-button"
          aria-label="Account settings"
          onClick={onOpenSettings}
        >
          <StartMenuUser avatarSize={28} className="win11-start-user" />
        </button>
        <div className="win11-start-power-wrap" ref={powerWrapRef}>
          {powerOpen ? (
            <div
              className="win11-power-flyout"
              role="menu"
              aria-label="Power options"
              onKeyDown={onFlyoutKeyDown}
            >
              <button type="button" role="menuitem" className="win11-power-flyout-item" onClick={openLockScreen}>
                <LockIcon aria-hidden="true" />
                <span>Lock</span>
              </button>
              <button type="button" role="menuitem" className="win11-power-flyout-item" onClick={openLockScreen}>
                <LogOutIcon aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="win11-start-power"
            aria-label="Power"
            aria-expanded={powerOpen}
            aria-haspopup="menu"
            onClick={() => setPowerOpen((open) => !open)}
            ref={powerButtonRef}
          >
            <PowerIcon aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
