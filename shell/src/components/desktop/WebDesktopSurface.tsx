"use client";

import { useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { AppEntry, AppWindow } from "@/hooks/useWindowManager";
import { useDesktopConfigStore, type DesktopIconPlacement } from "@/stores/desktop-config";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  Blocks,
  BrushIcon,
  Code2,
  FilePenLine,
  FileText,
  FolderKanban,
  FolderTree,
  Globe2,
  LayoutGrid,
  MessageCircle,
  Settings as SettingsGlyph,
  SquareTerminal,
  type LucideIcon,
} from "@/lib/hugeicons";
import { WebDesktopHeader } from "./WebDesktopHeader";
import type { WebDesktopSettingsSection } from "./WebDesktopControls";

interface WebDesktopSurfaceProps {
  apps: AppEntry[];
  windows: AppWindow[];
  fullscreenWindowId: string | null;
  launcherOpen: boolean;
  onOpenApp: (path: string, name?: string) => void;
  onOpenLauncher: () => void;
  onOpenSettings: (section: WebDesktopSettingsSection) => void;
  headerActions?: ReactNode;
  onActivateWindow: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onShowDesktop: () => void;
  onToggleFullscreen: (id: string) => void;
  children?: ReactNode;
  desktopIcons?: DesktopIconPlacement[];
  onMoveDesktopIcon?: (path: string, x: number, y: number) => void;
  onRemoveDesktopIcon?: (path: string) => void;
}

interface DesktopIconAppearance {
  color: string;
  iconColor: string;
  icon: LucideIcon;
}

const DEFAULT_APPEARANCE: DesktopIconAppearance = {
  color: "#FFFEFC",
  iconColor: "var(--primary, #434E3F)",
  icon: LayoutGrid,
};

export function desktopAppearanceForApp(app: AppEntry): DesktopIconAppearance {
  const name = app.name.toLowerCase();
  if (name === "browser") {
    return { color: "var(--surface-info-emphasis, #3B85BA)", iconColor: "white", icon: Globe2 };
  }
  if (app.path === "__chat__" || name === "chat" || name === "hermes") {
    return { color: "var(--surface-success-emphasis, #288A5B)", iconColor: "white", icon: MessageCircle };
  }
  if (app.path.startsWith("__terminal__")) {
    return { color: "var(--surface-warning-emphasis, #E0AA52)", iconColor: "white", icon: SquareTerminal };
  }
  if (app.path === "__file-browser__") {
    return { color: "var(--surface-brand-emphasis, #748E59)", iconColor: "white", icon: FolderTree };
  }
  if (app.path === "__editor__") {
    return { color: "#4D7FA8", iconColor: "white", icon: FilePenLine };
  }
  if (app.path === "__vscode__") {
    return { color: "#FFFEFC", iconColor: "#007ACC", icon: Code2 };
  }
  if (app.path === "__plugins__" || name === "plugins") {
    return { color: "#7C6DB4", iconColor: "white", icon: Blocks };
  }
  if (app.path === "__settings__") {
    return { color: "var(--surface-neutral-emphasis, #6B7280)", iconColor: "white", icon: SettingsGlyph };
  }
  if (name === "notes") {
    return { color: "#E3B341", iconColor: "white", icon: FileText };
  }
  if (name === "whiteboard") {
    return { color: "#D46A92", iconColor: "white", icon: BrushIcon };
  }
  if (app.path === "__workspace__" || name === "projects") {
    return { color: "var(--surface-error-emphasis, #BA5236)", iconColor: "white", icon: FolderKanban };
  }
  return DEFAULT_APPEARANCE;
}

function DesktopAppIcon({ app, className = "" }: { app: AppEntry; className?: string }) {
  const appearance = desktopAppearanceForApp(app);
  const Glyph = appearance.icon;
  const isCanonicalDesktopApp = app.path.startsWith("__");
  return (
    <span
      data-desktop-app-icon
      className={`flex items-center justify-center overflow-hidden border border-black/5 shadow-[0_5px_16px_rgba(0,0,0,0.16)] ${className}`}
      style={{ background: appearance.color, color: appearance.iconColor }}
    >
      {app.iconUrl && (!isCanonicalDesktopApp || app.path === "__vscode__") ? (
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
  placement,
  onMove,
  onRemove,
}: {
  app: AppEntry;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  placement: DesktopIconPlacement;
  onMove?: (path: string, x: number, y: number) => void;
  onRemove?: (path: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label={app.name}
        data-selected={selected || undefined}
        className="group absolute flex w-[76px] touch-none flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 outline-none transition-colors hover:bg-white/10 focus-visible:bg-white/10 data-[selected]:bg-white/15"
        style={{ left: placement.x, top: placement.y + 38 }}
        onClick={onSelect}
        onDoubleClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !onMove) return;
          const target = event.currentTarget;
          const startX = event.clientX;
          const startY = event.clientY;
          const move = (moveEvent: PointerEvent) => {
            target.style.left = `${Math.max(0, placement.x + moveEvent.clientX - startX)}px`;
            target.style.top = `${38 + Math.max(0, placement.y + moveEvent.clientY - startY)}px`;
          };
          const up = (upEvent: PointerEvent) => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
            const dx = upEvent.clientX - startX;
            const dy = upEvent.clientY - startY;
            if (Math.abs(dx) + Math.abs(dy) > 3) onMove(app.path, Math.max(0, placement.x + dx), Math.max(0, placement.y + dy));
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", up);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onOpen();
        }}
      >
      <DesktopAppIcon
        app={app}
        className="relative size-12 rounded-[14px] transition-transform duration-150 group-hover:-translate-y-0.5"
      />
      <span
        className="max-w-full truncate text-[12px] font-medium text-white"
        style={{ textShadow: "0 1px 2px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.8)" }}
      >
        {app.name === "Hermes" ? "Chat" : app.name}
      </span>
      </button>
      {menu && onRemove ? (
        <div role="menu" className="pointer-events-auto fixed min-w-48 rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg" style={{ left: menu.x, top: menu.y, zIndex: SHELL_Z_INDEX.launchpad }}>
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
            onClick={() => {
              onRemove(app.path);
              setMenu(null);
            }}
          >
            Remove {app.name === "Hermes" ? "Chat" : app.name} from Desktop
          </button>
        </div>
      ) : null}
    </>
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
  fullscreenWindowId,
  launcherOpen,
  onOpenApp,
  onOpenLauncher,
  onOpenSettings,
  headerActions,
  onActivateWindow,
  onCloseWindow,
  onShowDesktop,
  onToggleFullscreen,
  children,
  desktopIcons,
  onMoveDesktopIcon,
  onRemoveDesktopIcon,
}: WebDesktopSurfaceProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const primeDesktopIcons = useDesktopConfigStore((state) => state.primeDesktopIcons);
  const desktopApps = useMemo(() => {
    const preferred = [
      apps.find((app) => app.path === "__chat__")
        ? { ...apps.find((app) => app.path === "__chat__")!, name: "Chat" }
        : undefined,
      apps.find((app) => app.path === "__terminal__"),
      apps.find((app) => app.path === "__file-browser__"),
      { name: "Editor", path: "__editor__" },
      { name: "VS Code", path: "__vscode__", iconUrl: "/vscode.png" },
      { name: "Settings", path: "__settings__" },
      { name: "Plugins", path: "__plugins__" },
      apps.find((app) => app.name.toLowerCase() === "browser") ?? { name: "Browser", path: "__browser__" },
      apps.find((app) => app.name.toLowerCase() === "notes") ?? { name: "Notes", path: "apps/notes/index.html" },
      apps.find((app) => app.name.toLowerCase() === "whiteboard") ?? { name: "Whiteboard", path: "apps/whiteboard/index.html" },
    ];
    const seen = new Set<string>();
    return preferred.filter((app): app is AppEntry => {
      if (!app || seen.has(app.path)) return false;
      seen.add(app.path);
      return true;
    });
  }, [apps]);
  const defaultPlacements = useMemo<DesktopIconPlacement[]>(() => desktopApps.map((app, index) => ({
    path: app.path,
    x: 20 + (index % 2) * 88,
    y: 20 + Math.floor(index / 2) * 92,
  })), [desktopApps]);
  useLayoutEffect(() => {
    if (desktopIcons === undefined) primeDesktopIcons(defaultPlacements);
  }, [defaultPlacements, desktopIcons, primeDesktopIcons]);
  const placements = desktopIcons ?? defaultPlacements;
  const placedApps = useMemo(() => placements.flatMap((placement) => {
    const app = desktopApps.find((candidate) => candidate.path === placement.path)
      ?? apps.find((candidate) => candidate.path === placement.path);
    return app ? [{ app, placement }] : [];
  }), [apps, desktopApps, placements]);
  const filesApp = apps.find((app) => app.path === "__file-browser__");
  const filesWindow = windows.find((windowRecord) => windowRecord.path === "__file-browser__");
  const otherRunningWindows = windows.filter((windowRecord) => windowRecord.path !== "__file-browser__");
  const renderWindowIcon = (windowRecord: AppWindow, large = false) => {
    const app = apps.find((candidate) => (
      windowRecord.path === candidate.path || windowRecord.path.startsWith(`${candidate.path}:`)
    )) ?? { name: windowRecord.title, path: windowRecord.path };
    return (
      <DesktopAppIcon
        app={app}
        className={large
          ? "size-16 rounded-[20px]"
          : "size-4 rounded-[4px] border-0 shadow-none"}
      />
    );
  };

  const surfaceStyle = {
    "--web-desktop-taskbar-bg": "color-mix(in srgb, var(--card) 72%, transparent)",
  } as CSSProperties;

  return (
    <section
      data-web-desktop-shell
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={surfaceStyle}
    >
      <WebDesktopHeader
        windows={windows}
        fullscreenWindowId={fullscreenWindowId}
        renderWindowIcon={renderWindowIcon}
        onActivateWindow={onActivateWindow}
        onCloseWindow={onCloseWindow}
        onShowDesktop={onShowDesktop}
        onToggleFullscreen={onToggleFullscreen}
        rightActions={headerActions}
      />

      <nav
        aria-label="Desktop apps"
        className="pointer-events-auto absolute inset-0"
        style={{ zIndex: SHELL_Z_INDEX.desktopIcons }}
      >
        {placedApps.map(({ app, placement }) => (
          <DesktopDestination
            key={app.path}
            app={app}
            placement={placement}
            onMove={onMoveDesktopIcon}
            onRemove={onRemoveDesktopIcon}
            selected={selectedPath === app.path}
            onSelect={() => setSelectedPath(app.path)}
            onOpen={() => {
              if (app.path === "__settings__") onOpenSettings("appearance");
              else if (app.path === "__plugins__") onOpenSettings("integrations");
              else onOpenApp(app.path, app.name);
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
            else if (filesApp) onOpenApp(filesApp.path, filesApp.name);
          }}
        >
          <DesktopAppIcon
            app={filesApp ?? { name: "Files", path: "__file-browser__" }}
            className="relative size-11 rounded-[13px]"
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
                    <DesktopAppIcon app={app} className="relative size-11 rounded-[13px]" />
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
