"use client";

import { useEffect, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { useIconWithFallback } from "@/hooks/useIconWithFallback";
import type { AppEntry } from "@/hooks/useWindowManager";
import { groupLauncherApps } from "@/lib/dock-sections";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  computeLaunchpadColumns,
  computeLaunchpadPageSize,
  filterLaunchpadApps,
  paginateLaunchpadApps,
} from "./launchpad-utils";
import "./launchpad.css";

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
}: {
  apps: AppEntry[];
  visible: boolean;
  onOpenApp: (name: string, path: string) => void;
  onClose: () => void;
}) {
  // Keep the registry's stable order, flattened from the classic sections.
  const groups = groupLauncherApps(apps);
  const orderedApps = [...groups.mainApps, ...groups.generatedApps, ...groups.gameApps];

  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
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
                <LaunchpadTile key={app.path} app={app} onLaunch={() => launch(app)} />
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
      </div>
    </div>
  );
}

function LaunchpadTile({ app, onLaunch }: { app: AppEntry; onLaunch: () => void }) {
  const { showImage, onError } = useIconWithFallback(app.iconUrl);
  return (
    <button type="button" data-launchpad-tile className="launchpad-tile" onClick={onLaunch}>
      <span className="launchpad-icon">
        {showImage && app.iconUrl ? (
          // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png) that cannot be statically configured for next/image
          <img src={app.iconUrl} alt="" draggable={false} onError={onError} />
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
