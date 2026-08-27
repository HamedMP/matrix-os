"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { AppEntry, AppWindow } from "@/hooks/useWindowManager";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  FolderTree,
  LayoutGrid,
  MessageCircle,
  Settings as SettingsGlyph,
  SquareTerminal,
  type LucideIcon,
} from "@/lib/hugeicons";

interface WebDesktopSurfaceProps {
  apps: AppEntry[];
  windows: AppWindow[];
  launcherOpen: boolean;
  onOpenApp: (name: string, path: string) => void;
  onOpenLauncher: () => void;
  onOpenSettings: () => void;
  onActivateWindow: (id: string) => void;
  children?: ReactNode;
}

interface DesktopIconAppearance {
  color: string;
  icon: LucideIcon;
}

const DEFAULT_APPEARANCE: DesktopIconAppearance = {
  color: "var(--primary, #434E3F)",
  icon: LayoutGrid,
};

function appearanceForPath(path: string): DesktopIconAppearance {
  if (path.startsWith("__terminal__")) {
    return { color: "#E0AA52", icon: SquareTerminal };
  }
  if (path === "__file-browser__") {
    return { color: "var(--primary, #748E59)", icon: FolderTree };
  }
  if (path === "__chat__") {
    return { color: "#288A5B", icon: MessageCircle };
  }
  if (path === "__settings__") {
    return { color: "#6B7280", icon: SettingsGlyph };
  }
  return DEFAULT_APPEARANCE;
}

function DesktopAppIcon({ app, className = "" }: { app: AppEntry; className?: string }) {
  const appearance = appearanceForPath(app.path);
  const Glyph = appearance.icon;
  const isCanonicalDesktopApp = app.path.startsWith("__");
  return (
    <span
      className={`relative flex items-center justify-center overflow-hidden ${className}`}
      style={{ background: appearance.color, color: "white" }}
    >
      {app.iconUrl && !isCanonicalDesktopApp ? (
        // Gateway-owned app icons can change at runtime and are already
        // versioned by ETag, so Next/Image cannot statically optimize them.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={app.iconUrl} alt="" className="size-full object-cover" draggable={false} />
      ) : (
        <Glyph className="size-[48%]" aria-hidden="true" />
      )}
    </span>
  );
}

function DesktopDestination({
  app,
  selected,
  onSelect,
  onOpen,
}: {
  app: AppEntry;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={app.name}
      data-selected={selected || undefined}
      className="group flex w-[76px] flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 outline-none transition-colors hover:bg-white/10 focus-visible:bg-white/10 data-[selected]:bg-white/15"
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <DesktopAppIcon
        app={app}
        className="size-12 rounded-[14px] border border-white/15 shadow-[0_8px_20px_rgba(0,0,0,0.18)] transition-transform duration-150 group-hover:-translate-y-0.5"
      />
      <span
        className="max-w-full truncate text-[12px] font-medium text-white"
        style={{ textShadow: "0 1px 2px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.8)" }}
      >
        {app.name === "Hermes" ? "Chat" : app.name}
      </span>
    </button>
  );
}

function TaskbarButton({
  label,
  title,
  children,
  running = false,
  pressed,
  onClick,
}: {
  label: string;
  title: string;
  children: ReactNode;
  running?: boolean;
  pressed?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5">
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        title={title}
        onClick={onClick}
        className="group relative flex size-11 items-center justify-center rounded-[13px] text-muted-foreground transition-transform hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-primary"
      >
        {children}
      </button>
      <span aria-hidden="true" className="flex h-1 items-center justify-center">
        {running ? <span className="size-1 rounded-full bg-primary" /> : null}
      </span>
    </div>
  );
}

/**
 * Browser adapter for the native Desktop composition. The app content and
 * window state remain web-owned; this component owns only the canonical OS
 * presentation: wallpaper plane, desktop icon grid, and centered taskbar.
 */
export function WebDesktopSurface({
  apps,
  windows,
  launcherOpen,
  onOpenApp,
  onOpenLauncher,
  onOpenSettings,
  onActivateWindow,
  children,
}: WebDesktopSurfaceProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const desktopApps = useMemo(() => {
    const preferred = [
      apps.find((app) => app.name.toLowerCase() === "browser"),
      apps.find((app) => app.path === "__chat__"),
      apps.find((app) => app.path === "__terminal__"),
      apps.find((app) => app.path === "__file-browser__"),
      { name: "Settings", path: "__settings__" },
      apps.find((app) => app.path === "__workspace__" || app.name.toLowerCase() === "projects"),
    ];
    const seen = new Set<string>();
    return preferred.filter((app): app is AppEntry => {
      if (!app || seen.has(app.path)) return false;
      seen.add(app.path);
      return true;
    });
  }, [apps]);
  const filesApp = apps.find((app) => app.path === "__file-browser__");
  const filesWindow = windows.find((windowRecord) => windowRecord.path === "__file-browser__");
  const otherRunningWindows = windows.filter((windowRecord) => windowRecord.path !== "__file-browser__");

  const surfaceStyle = {
    "--web-desktop-taskbar-bg": "color-mix(in srgb, var(--card) 48%, transparent)",
  } as CSSProperties;

  return (
    <section
      data-web-desktop-shell
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={surfaceStyle}
    >
      <nav
        aria-label="Desktop apps"
        className="pointer-events-auto absolute left-5 top-5 grid grid-cols-2 gap-x-3 gap-y-4"
        style={{ zIndex: SHELL_Z_INDEX.desktopIcons }}
      >
        {desktopApps.map((app) => (
          <DesktopDestination
            key={app.path}
            app={app}
            selected={selectedPath === app.path}
            onSelect={() => setSelectedPath(app.path)}
            onOpen={() => {
              if (app.path === "__settings__") onOpenSettings();
              else onOpenApp(app.name, app.path);
            }}
          />
        ))}
      </nav>

      {children ? <div className="pointer-events-auto absolute inset-0">{children}</div> : null}

      <nav
        aria-label="Running apps"
        className="pointer-events-auto absolute bottom-3 left-1/2 inline-flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-1.5 rounded-2xl border border-white/15 bg-[var(--web-desktop-taskbar-bg)] px-1.5 pt-1.5 shadow-[0_0_2px_rgba(0,0,0,.05),0_0_40px_rgba(0,0,0,.08)] backdrop-blur-[68px]"
        style={{ zIndex: SHELL_Z_INDEX.taskbar }}
      >
        <TaskbarButton
          label={launcherOpen ? "Close App Launcher" : "Open App Launcher"}
          title="App Launcher"
          pressed={launcherOpen}
          onClick={onOpenLauncher}
        >
          <span className="flex size-11 items-center justify-center rounded-[13px] bg-[#0D0C0C] text-[#FAFAF5]">
            <LayoutGrid className="size-[21px]" aria-hidden="true" />
          </span>
        </TaskbarButton>

        <TaskbarButton
          label={filesWindow
            ? filesWindow.minimized ? "Restore Files" : "Focus Files"
            : "Open Files"}
          title="Files"
          running={Boolean(filesWindow)}
          onClick={() => {
            if (filesWindow) onActivateWindow(filesWindow.id);
            else if (filesApp) onOpenApp(filesApp.name, filesApp.path);
          }}
        >
          <DesktopAppIcon
            app={filesApp ?? { name: "Files", path: "__file-browser__" }}
            className="absolute inset-0 rounded-[13px]"
          />
        </TaskbarButton>

        {otherRunningWindows.length > 0 ? (
          <>
            <span aria-hidden="true" className="mx-0.5 h-12.5 w-px shrink-0 bg-border" />
            <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {otherRunningWindows.map((windowRecord) => {
                const app = apps.find((candidate) => (
                  windowRecord.path === candidate.path || windowRecord.path.startsWith(`${candidate.path}:`)
                )) ?? { name: windowRecord.title, path: windowRecord.path };
                return (
                  <TaskbarButton
                    key={windowRecord.id}
                    label={`${windowRecord.minimized ? "Restore" : "Focus"} ${windowRecord.title}`}
                    title={windowRecord.title}
                    running
                    onClick={() => onActivateWindow(windowRecord.id)}
                  >
                    <DesktopAppIcon app={app} className="absolute inset-0 rounded-[13px]" />
                  </TaskbarButton>
                );
              })}
            </div>
          </>
        ) : null}
      </nav>
    </section>
  );
}
