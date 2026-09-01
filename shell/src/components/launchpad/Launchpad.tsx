"use client";

import { useEffect, useRef, useState } from "react";
import {
  Blocks,
  BrushIcon,
  Code2,
  FilePenLine,
  FolderTree,
  Globe2,
  MessageSquare,
  Notebook,
  PlusIcon,
  SearchIcon,
  Settings,
  SquareTerminal,
  type LucideIcon,
} from "@/lib/hugeicons";
import {
  OS_VIEW_CREATE_APP_APPEARANCE,
  osViewFixedAppAppearanceForPath,
  type OsViewFixedAppIcon,
} from "@matrix-os/contracts";
import { useIconWithFallback } from "@/hooks/useIconWithFallback";
import type { AppEntry } from "@/hooks/useWindowManager";
import { groupLauncherApps } from "@/lib/dock-sections";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { isOsViewDestinationPath } from "@/lib/web-desktop-app-launch";
import {
  computeLaunchpadColumns,
  computeLaunchpadPageSize,
  filterLaunchpadApps,
  paginateLaunchpadApps,
} from "./launchpad-utils";
import "./launchpad.css";

const BUILT_IN_ICON_COMPONENTS: Readonly<Record<OsViewFixedAppIcon, LucideIcon>> = {
  "message-square": MessageSquare,
  "square-terminal": SquareTerminal,
  "folder-tree": FolderTree,
  "file-pen": FilePenLine,
  code: Code2,
  settings: Settings,
  blocks: Blocks,
  globe: Globe2,
  notebook: Notebook,
  brush: BrushIcon,
};

/**
 * macOS Launchpad: full-screen frosted-glass app launcher used in place of
 * the classic MissionControl grid while the `macos-glass` design is active.
 * The parent (MissionControl) owns mount/unmount, the global Escape handler,
 * and the enter/exit timing; this component owns the backdrop, search,
 * pagination, and tiles. Styling lives in launchpad.css; the glass tokens
 * (--glass-blur etc.) resolve from globals.css under macos-glass.
 */
export function Launchpad({
  apps,
  visible,
  onOpenApp,
  onClose,
  onAddToDesktop,
}: {
  apps: AppEntry[];
  visible: boolean;
  onOpenApp: (name: string, path: string) => void;
  onClose: () => void;
  onAddToDesktop?: (path: string) => void;
}) {
  // Keep the registry's stable order, flattened from the classic sections.
  const groups = groupLauncherApps(apps);
  const orderedApps = [...groups.mainApps, ...groups.generatedApps, ...groups.gameApps];

  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [contextApp, setContextApp] = useState<AppEntry | null>(null);
  const filteredApps = filterLaunchpadApps(orderedApps, query);

  // Viewport-derived page size. window is only read inside this effect
  // (SSR-safe); until it runs, everything renders on a single page.
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const readViewport = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    readViewport();
    window.addEventListener("resize", readViewport);
    return () => window.removeEventListener("resize", readViewport);
  }, []);

  const pageSize = viewport ? computeLaunchpadPageSize(viewport.width, viewport.height) : 0;
  const pages = pageSize > 0 ? paginateLaunchpadApps(filteredApps, pageSize) : [filteredApps];
  // Clamp derived in render (not state) so filtering/resizing below the
  // current page count can never leave an out-of-range active page.
  const activePage = Math.min(pageIndex, pages.length - 1);
  const columns = viewport ? computeLaunchpadColumns(viewport.width) : 7;
  const pageApps = pages[activePage] ?? [];
  // A sparse or final page should center the apps themselves, not a wider
  // invisible set of empty grid tracks.
  const visibleColumns = Math.min(columns, pageApps.length);

  // Full-screen take-over: lock body scroll for the lifetime of the overlay.
  useEffect(() => {
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, []);

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (visible) searchRef.current?.focus();
  }, [visible]);

  const launch = (app: AppEntry) => {
    onOpenApp(app.name, app.path);
    onClose();
  };

  return (
    <div
      data-launchpad
      data-visible={visible ? "true" : undefined}
      className="launchpad-root"
      style={{ zIndex: SHELL_Z_INDEX.launchpad }}
    >
      {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss backdrop: a pure pointer convenience that closes Launchpad only when the empty area itself is clicked. Keyboard dismiss is provided by the launcher's global Escape handler (MissionControl), and the real controls are focusable buttons. */}
      <div
        data-launchpad-backdrop
        className="launchpad-backdrop"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      />

      {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss surface: closes Launchpad only when this empty wrapper itself (not its children) is clicked. Keyboard dismiss is handled by the launcher's global Escape handler. */}
      <div
        className="launchpad-content"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="launchpad-search-row">
          <div className="launchpad-search">
            <SearchIcon className="launchpad-search-icon" aria-hidden />
            <input
              ref={searchRef}
              type="text"
              aria-label="Search apps"
              placeholder="Search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPageIndex(0);
              }}
              className="launchpad-search-input"
            />
          </div>
        </div>

        {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss surface: closes Launchpad only when the empty area around the grid (not a tile) is clicked. Keyboard dismiss is handled by the launcher's global Escape handler. */}
        <div
          className="launchpad-grid-area"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {pageApps.length > 0 ? (
            // react-doctor-disable-next-line react-doctor/click-events-have-key-events, react-doctor/no-static-element-interactions -- light-dismiss surface: closes Launchpad only when the empty grid gap (not an app tile) is clicked, like real Launchpad. Keyboard dismiss is handled by the launcher's global Escape handler.
            <div
              data-launchpad-grid
              className="launchpad-grid"
              style={{ gridTemplateColumns: `repeat(${visibleColumns}, var(--launchpad-cell-w))` }}
              onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
              }}
            >
              {pageApps.map((app) => (
                <LaunchpadTile
                  key={app.path}
                  app={app}
                  onLaunch={() => launch(app)}
                  onContextMenu={isOsViewDestinationPath(app.path) ? undefined : () => setContextApp(app)}
                />
              ))}
            </div>
          ) : (
            <p className="launchpad-empty">No apps match &ldquo;{query}&rdquo;</p>
          )}
        </div>

        <div className="launchpad-dots-row">
          {pages.length > 1 &&
            pages.map((_, i) => (
              <button
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- page dots are position-identified by design: pages are append-only and never reordered or filtered, so the index is the stable id
                key={i}
                type="button"
                aria-label={`Go to page ${i + 1} of ${pages.length}`}
                aria-current={i === activePage ? "page" : undefined}
                className={`launchpad-dot${i === activePage ? " launchpad-dot--active" : ""}`}
                onClick={() => setPageIndex(i)}
              />
            ))}
        </div>
        {contextApp && contextApp.path !== "__create-app__" && onAddToDesktop ? (
          <div role="menu" className="fixed left-1/2 top-1/2 z-50 min-w-48 -translate-x-1/2 rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg">
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => {
                onAddToDesktop(contextApp.path);
                setContextApp(null);
              }}
            >
              Add {contextApp.name} to Desktop
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LaunchpadTile({ app, onLaunch, onContextMenu }: { app: AppEntry; onLaunch: () => void; onContextMenu?: () => void }) {
  const { showImage, onError } = useIconWithFallback(app.iconUrl);
  const builtInAppearance = osViewFixedAppAppearanceForPath(app.path);
  const BuiltInIcon = builtInAppearance
    ? BUILT_IN_ICON_COMPONENTS[builtInAppearance.icon]
    : undefined;
  const useFixedIcon = BuiltInIcon && builtInAppearance?.iconSource === "fixed";
  return (
    <button type="button" aria-label={app.name} data-launchpad-tile className="launchpad-tile" onClick={onLaunch} onContextMenu={onContextMenu ? (event) => { event.preventDefault(); onContextMenu(); } : undefined}>
      <span className="launchpad-icon">
        {app.path === "__create-app__" ? (
          <span
            data-launchpad-create-icon
            className="flex size-full items-center justify-center"
            style={{
              background: OS_VIEW_CREATE_APP_APPEARANCE.background,
              color: OS_VIEW_CREATE_APP_APPEARANCE.foreground,
            }}
          >
            <PlusIcon className="size-12" aria-hidden="true" />
          </span>
        ) : useFixedIcon && builtInAppearance ? (
          <span
            data-launchpad-built-in-icon
            className="flex size-full items-center justify-center"
            style={{
              background: builtInAppearance.background,
              color: builtInAppearance.foreground,
            }}
            aria-hidden="true"
          >
            <BuiltInIcon className="size-8" />
          </span>
        ) : showImage && app.iconUrl ? (
          // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png) that cannot be statically configured for next/image
          <img src={app.iconUrl} alt="" draggable={false} onError={onError} />
        ) : BuiltInIcon && builtInAppearance ? (
          <span
            data-launchpad-built-in-icon
            className="flex size-full items-center justify-center"
            style={{
              background: builtInAppearance.background,
              color: builtInAppearance.foreground,
            }}
            aria-hidden="true"
          >
            <BuiltInIcon className="size-8" />
          </span>
        ) : (
          <span className="launchpad-icon-fallback" aria-hidden>
            {app.name.charAt(0).toUpperCase()}
          </span>
        )}
      </span>
      <span className="launchpad-label">{app.name}</span>
    </button>
  );
}
