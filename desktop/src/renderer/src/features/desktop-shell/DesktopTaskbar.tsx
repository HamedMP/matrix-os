import { LayoutGrid } from "lucide-react";
import type { ReactNode } from "react";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import DesktopAppIcon from "./DesktopAppIcon";
import { desktopAppAppearance } from "./desktop-apps";
import SurfaceIcon from "./SurfaceIcon";
import { DESKTOP_Z_INDEX } from "../../design/layering";

function DockAppButton({
  label,
  title,
  icon,
  color,
  iconColor,
  active,
  minimized,
  running,
  pressed,
  onClick,
  testId,
}: {
  label: string;
  title: string;
  icon: ReactNode;
  color?: string;
  iconColor?: string;
  active?: boolean;
  minimized?: boolean;
  running?: boolean;
  pressed?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5">
      <button
        data-testid={testId}
        type="button"
        aria-label={label}
        title={title}
        aria-pressed={pressed}
        data-active={active || undefined}
        data-minimized={minimized || undefined}
        className="group relative flex size-11 items-center justify-center rounded-[13px] text-[var(--text-secondary)] data-[active]:text-[var(--accent)] data-[minimized]:opacity-70"
        onClick={onClick}
      >
        <DesktopAppIcon
          name={title}
          icon={icon}
          color={color}
          iconColor={iconColor}
          className="absolute inset-0 rounded-[13px] transition-transform group-hover:-translate-y-0.5"
        />
      </button>
      <span aria-hidden="true" className="flex h-1 items-center justify-center">
        {running ? <span data-taskbar-running-indicator className="size-1 rounded-full bg-[var(--accent)]" /> : null}
      </span>
    </div>
  );
}

export default function DesktopTaskbar({
  tabs,
  surfaces,
  activeTabId,
  onOpenApps,
  onOpenFiles,
  launcherOpen,
  onActivate,
}: {
  tabs: Tab[];
  surfaces: Record<string, DesktopSurface>;
  activeTabId: string | null;
  onOpenApps: () => void;
  onOpenFiles: () => void;
  launcherOpen: boolean;
  onActivate: (tabId: string) => void;
}) {
  const runningTabs = tabs.filter((tab) => {
    const mode = surfaces[tab.id]?.mode;
    return mode !== undefined && mode !== "closed";
  });
  const filesTab = runningTabs.find((tab) => tab.kind === "files");
  const filesSurface = filesTab ? surfaces[filesTab.id] : undefined;
  const filesActive = Boolean(filesTab && filesSurface && activeTabId === filesTab.id && filesSurface.mode !== "minimized");
  const otherRunningTabs = runningTabs.filter((tab) => tab.kind !== "files");
  const filesLabel = !filesTab
    ? "Open Files"
    : filesSurface?.mode === "minimized"
      ? "Restore Files"
      : "Focus Files";
  return (
    <nav
      aria-label="Running apps"
      className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center"
      style={{
        zIndex: DESKTOP_Z_INDEX.nativeDesktopTaskbar,
        maxWidth: "calc(100% - 24px)",
        display: "inline-flex",
        borderRadius: "16px",
        border: "1px solid rgba(255, 255, 255, 0.15)",
        background: "rgba(255, 255, 255, 0.30)",
        boxShadow: "0 0 2px 0 rgba(0, 0, 0, 0.05), 0 0 40px 0 rgba(0, 0, 0, 0.05)",
        backdropFilter: "blur(67.95704650878906px)",
        padding: "6px 6px 0",
        gap: "6px",
      }}
      >
      <div data-testid="desktop-taskbar-static-apps" className="flex shrink-0 items-center gap-1.5">
        <DockAppButton
          label={launcherOpen ? "Close App Launcher" : "Open App Launcher"}
          title="App Launcher"
          icon={<LayoutGrid size={21} aria-hidden="true" />}
          color="var(--surface-inverse, #0D0C0C)"
          iconColor="#FAFAF5"
          pressed={launcherOpen}
          onClick={onOpenApps}
        />
        <DockAppButton
          testId="desktop-taskbar-files"
          label={filesLabel}
          title="Files"
          icon={<SurfaceIcon tab={{ kind: "files", title: "Files" }} size={21} />}
          {...desktopAppAppearance("files")}
          active={filesActive}
          minimized={filesSurface?.mode === "minimized"}
          running={Boolean(filesTab)}
          onClick={() => {
            if (!filesTab) onOpenFiles();
            else onActivate(filesTab.id);
          }}
        />
      </div>
      {otherRunningTabs.length > 0 ? <>
        <span className="mx-0.5 h-12.5 w-px shrink-0" style={{ background: "var(--border-default)" }} />
        <div
          data-testid="desktop-taskbar-running-apps"
          className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {otherRunningTabs.map((tab) => {
          const surface = surfaces[tab.id]!;
          const active = activeTabId === tab.id && surface.mode !== "minimized";
          const label = surface.mode === "minimized"
            ? `Restore ${tab.title}`
            : `Focus ${tab.title}`;
          return (
            <DockAppButton
              key={tab.id}
              label={label}
              title={tab.title}
              icon={<SurfaceIcon tab={tab} size={21} />}
              {...desktopAppAppearance(tab.kind)}
              active={active}
              minimized={surface.mode === "minimized"}
              running
              onClick={() => onActivate(tab.id)}
            />
          );
          })}
        </div>
      </> : null}
      <DesktopUpdateButton collapsed />
    </nav>
  );
}
