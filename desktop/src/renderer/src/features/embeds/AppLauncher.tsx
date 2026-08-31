import { LayoutGrid, Plus, Search } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EmptyState } from "../../design/primitives";
import { appIconUrl, useAppsQuery, type MatrixApp } from "../apps/apps.api";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { FIXED_DESKTOP_APPS, type DesktopAppConfig } from "../desktop-shell/desktop-apps";
import {
  OS_VIEW_DESTINATION_PATHS,
  OS_VIEW_LABELS,
  otherOsViewMode,
  type OsViewMode,
} from "@matrix-os/contracts";
import canvasIconUrl from "../../../../../../home/system/icons/canvas.svg";
import desktopIconUrl from "../../../../../../home/system/icons/desktop.svg";

type LauncherEntry =
  | { type: "create"; key: "__create-app__"; name: "Create app" }
  | { type: "os-view"; key: string; name: string; mode: OsViewMode; iconUrl: string }
  | { type: "fixed"; key: string; name: string; app: DesktopAppConfig }
  | { type: "installed"; key: string; name: string; app: MatrixApp };

function AppIcon({ url, name, large = false }: { url: string | null; name: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const prev = useRef<string | null>(null);
  if (prev.current !== url) {
    prev.current = url;
    if (failed) setFailed(false);
  }
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        className={`${large ? "h-16 w-16 rounded-[18px]" : "h-11 w-11 rounded-xl"} object-cover shadow-[var(--shadow-1)]`}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={`flex items-center justify-center font-semibold shadow-[var(--shadow-1)] ${large ? "h-16 w-16 rounded-[18px] text-xl" : "h-11 w-11 rounded-xl text-lg"}`}
      style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default function AppLauncher({
  presentation = "surface",
  launcherActive = true,
  onLaunch,
  onCreateApp,
  onOpenDesktopApp,
  onAddToDesktop,
  osViewMode,
  onSwitchOsView,
}: {
  presentation?: "surface" | "launchpad";
  launcherActive?: boolean;
  onLaunch?: (tabId: string) => void;
  onCreateApp?: () => void;
  onOpenDesktopApp?: (app: DesktopAppConfig) => void;
  onAddToDesktop?: (path: string) => void;
  osViewMode?: OsViewMode;
  onSwitchOsView?: (mode: OsViewMode) => void;
} = {}) {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const openTab = useTabs((s) => s.openTab);
  const {
    data: apps = [],
    isPending,
    isFetching,
    error,
    refetch,
  } = useAppsQuery();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [contextEntry, setContextEntry] = useState<LauncherEntry | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Launcher behavior: focus the search immediately like a desktop launcher.
  useEffect(() => {
    if (launcherActive) inputRef.current?.focus();
  }, [launcherActive]);

  const entries = useMemo<LauncherEntry[]>(() => {
    if (presentation !== "launchpad") {
      return apps.map((app) => ({ type: "installed", key: `installed:${app.slug}`, name: app.name, app }));
    }
    const fixedNames = new Set(FIXED_DESKTOP_APPS.map((app) => app.name.toLowerCase()));
    const destinationMode = osViewMode ? otherOsViewMode(osViewMode) : null;
    return [
      { type: "create", key: "__create-app__", name: "Create app" },
      ...(destinationMode ? [{
        type: "os-view" as const,
        key: OS_VIEW_DESTINATION_PATHS[destinationMode],
        name: OS_VIEW_LABELS[destinationMode],
        mode: destinationMode,
        iconUrl: destinationMode === "canvas" ? canvasIconUrl : desktopIconUrl,
      }] : []),
      ...FIXED_DESKTOP_APPS.map((app) => {
        const installed = apps.find((candidate) => candidate.name.toLowerCase() === app.name.toLowerCase());
        return {
          type: "fixed" as const,
          key: app.path,
          name: app.name,
          app: installed
            ? { ...app, iconUrl: appIconUrl(platformHost, installed.slug, runtimeSlot) ?? app.iconUrl }
            : app,
        };
      }),
      ...apps
        .filter((app) => !fixedNames.has(app.name.toLowerCase()))
        .map((app) => ({ type: "installed" as const, key: `installed:${app.slug}`, name: app.name, app })),
    ];
  }, [apps, osViewMode, platformHost, presentation, runtimeSlot]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(q)
      || (entry.type === "installed" && entry.app.slug.toLowerCase().includes(q)));
  }, [entries, query]);

  const activeIndex = filtered.length === 0 ? 0 : Math.min(active, filtered.length - 1);

  const openInstalled = (app: MatrixApp) => {
    const tabId = openTab({
      kind: "app",
      slug: app.slug,
      title: app.name,
      ...(app.appIdentity ? { appIdentity: app.appIdentity } : {}),
      ...(appIconUrl(platformHost, app.slug, runtimeSlot) ? { icon: appIconUrl(platformHost, app.slug, runtimeSlot)! } : {}),
    });
    onLaunch?.(tabId);
  };

  const open = (entry: LauncherEntry) => {
    if (entry.type === "create") {
      onCreateApp?.();
      return;
    }
    if (entry.type === "os-view") {
      onSwitchOsView?.(entry.mode);
      return;
    }
    if (entry.type === "fixed") {
      onOpenDesktopApp?.(entry.app);
      return;
    }
    openInstalled(entry.app);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = filtered[activeIndex];
      if (entry) open(entry);
    }
  };

  if (presentation !== "launchpad" && error) {
    return (
      <EmptyState
        icon={<LayoutGrid size={26} />}
        headline="Apps unavailable"
        description="The app catalog could not be loaded. Try again once your computer is reachable."
        action={
          api ? (
            <Button variant="primary" disabled={isFetching} onClick={() => void refetch()}>
              {isFetching ? "Loading..." : "Retry"}
            </Button>
          ) : null
        }
      />
    );
  }

  if (presentation !== "launchpad" && !isPending && !isFetching && apps.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid size={26} />}
        headline="No apps installed"
        description="Matrix OS apps you install appear here, ready to launch in this window."
      />
    );
  }

  if (presentation !== "launchpad" && isPending && apps.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid size={26} />}
        headline="Loading apps"
        description="The app catalog will appear here once your computer responds."
      />
    );
  }

  return (
    <div
      data-app-launcher-presentation={presentation}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className={`shrink-0 px-6 pb-3 ${presentation === "launchpad" ? "mx-auto w-full max-w-2xl pt-10" : "pt-6"}`}>
        <div
          data-launchpad-interactive={presentation === "launchpad" || undefined}
          className="prompt-card flex items-center gap-2 rounded-xl border px-3 backdrop-blur-2xl"
          style={{
            background: presentation === "launchpad"
              ? "color-mix(in srgb, var(--bg-surface) 72%, transparent)"
              : "var(--bg-surface)",
          }}
        >
          <Search size={15} style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="h-11 w-full bg-transparent text-md outline-none"
            style={{ color: "var(--text-primary)", boxShadow: "none", borderRadius: 0 }}
          />
        </div>
      </div>
      <div className={`flex flex-1 flex-col gap-4 overflow-y-auto px-6 pb-24 ${presentation === "launchpad" ? "mx-auto w-full max-w-6xl" : ""}`}>
        {filtered.length === 0 ? (
          <p className="px-1 text-sm" style={{ color: "var(--text-tertiary)" }}>No apps match “{query}”.</p>
        ) : (
          <div data-testid="desktop-launcher-grid" className={`grid ${presentation === "launchpad" ? "grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-5 gap-y-6" : "grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-3"}`}>
            {filtered.map((entry, i) => {
              const highlighted = i === activeIndex;
              return (
                <button
                  key={entry.key}
                  type="button"
                  aria-label={entry.name}
                  data-launchpad-interactive={presentation === "launchpad" || undefined}
                  className={`flex flex-col items-center gap-2 rounded-xl transition-colors duration-100 ${presentation === "launchpad" ? "border border-transparent p-3" : "border p-4"}`}
                  style={{
                    background: highlighted
                      ? "color-mix(in srgb, var(--bg-selected) 78%, transparent)"
                      : presentation === "launchpad" ? "transparent" : "var(--bg-surface)",
                    borderColor: highlighted ? "var(--accent)" : presentation === "launchpad" ? "transparent" : "var(--border-subtle)",
                  }}
                  onMouseEnter={() => setActive(i)}
                  onContextMenu={(event) => {
                    if (entry.type === "create" || entry.type === "os-view") return;
                    event.preventDefault();
                    setContextEntry(entry);
                  }}
                  onClick={() => open(entry)}
                >
                  {entry.type === "create" ? (
                    <span className="flex size-16 items-center justify-center rounded-[18px] bg-[var(--accent)] text-white shadow-[var(--shadow-1)]">
                      <Plus size={40} aria-hidden="true" />
                    </span>
                  ) : entry.type === "os-view" ? (
                    <img src={entry.iconUrl} alt="" className="size-16 rounded-[18px] object-cover shadow-[var(--shadow-1)]" draggable={false} />
                  ) : entry.type === "fixed" ? (
                    <span className="flex size-16 items-center justify-center rounded-[18px] shadow-[var(--shadow-1)]" style={{ background: entry.app.color, color: entry.app.iconColor }}>
                      {entry.app.iconUrl
                        ? <img src={entry.app.iconUrl} alt="" className="size-full rounded-[18px] object-cover" draggable={false} />
                        : <entry.app.icon size={32} aria-hidden="true" />}
                    </span>
                  ) : (
                    <AppIcon url={appIconUrl(platformHost, entry.app.slug, runtimeSlot)} name={entry.name} large={presentation === "launchpad"} />
                  )}
                  <span
                    className="w-full truncate text-center text-sm font-medium"
                    style={{ color: "var(--text-primary)", textShadow: presentation === "launchpad" ? "0 1px 2px var(--bg-app)" : undefined }}
                  >
                    {entry.name}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {contextEntry && contextEntry.type !== "os-view" && onAddToDesktop ? (
          <div role="menu" data-launchpad-interactive className="fixed left-1/2 top-1/2 z-50 min-w-48 -translate-x-1/2 rounded-xl border bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-3)]">
            <button
              type="button"
              role="menuitem"
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-hover)]"
              onClick={() => {
                if (contextEntry.type === "create") return;
                const path = contextEntry.app.path;
                if (path) onAddToDesktop(path);
                setContextEntry(null);
              }}
            >
              Add {contextEntry.name} to Desktop
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
