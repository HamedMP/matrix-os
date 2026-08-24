import { LayoutGrid } from "lucide-react";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import SurfaceIcon from "./SurfaceIcon";
import { DESKTOP_Z_INDEX } from "../../design/layering";

export default function DesktopTaskbar({
  tabs,
  surfaces,
  activeTabId,
  onOpenApps,
  launcherOpen,
  onActivate,
  onMinimize,
}: {
  tabs: Tab[];
  surfaces: Record<string, DesktopSurface>;
  activeTabId: string | null;
  onOpenApps: () => void;
  launcherOpen: boolean;
  onActivate: (tabId: string) => void;
  onMinimize: (tabId: string) => void;
}) {
  const runningTabs = tabs.filter((tab) => {
    const mode = surfaces[tab.id]?.mode;
    return mode !== undefined && mode !== "closed";
  });
  return (
    <nav
      aria-label="Running apps"
      className="absolute bottom-3 left-1/2 flex h-[62px] -translate-x-1/2 items-center gap-1.5 rounded-[19px] border px-2.5 backdrop-blur-2xl"
      style={{
        zIndex: DESKTOP_Z_INDEX.nativeDesktopTaskbar,
        maxWidth: "calc(100% - 24px)",
        borderColor: "color-mix(in srgb, var(--border-default) 76%, transparent)",
        background: "color-mix(in srgb, var(--bg-surface) 76%, transparent)",
        boxShadow: "var(--shadow-2), inset 0 1px 0 color-mix(in srgb, white 72%, transparent)",
      }}
    >
      <button
        type="button"
        aria-label={launcherOpen ? "Close App Launcher" : "Open App Launcher"}
        aria-pressed={launcherOpen}
        title="App Launcher"
        className="flex size-11 shrink-0 items-center justify-center rounded-[13px] bg-[var(--accent)] text-[var(--text-on-accent)] shadow-[var(--shadow-1)] transition-transform hover:-translate-y-0.5"
        onClick={onOpenApps}
      >
        <LayoutGrid size={21} aria-hidden="true" />
      </button>
      {runningTabs.length > 0 ? <>
        <span className="mx-0.5 h-8 w-px shrink-0" style={{ background: "var(--border-default)" }} />
        <div
          data-testid="desktop-taskbar-running-apps"
          className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {runningTabs.map((tab) => {
          const surface = surfaces[tab.id]!;
          const active = activeTabId === tab.id && surface.mode !== "minimized";
          const label = surface.mode === "minimized"
            ? `Restore ${tab.title}`
            : active
              ? `Hide ${tab.title} to taskbar`
              : `Focus ${tab.title}`;
          return (
            <button
              key={tab.id}
              type="button"
              aria-label={label}
              title={tab.title}
              data-active={active || undefined}
              data-minimized={surface.mode === "minimized" || undefined}
              className="group relative flex size-11 shrink-0 items-center justify-center rounded-[13px] border border-transparent bg-[var(--bg-surface)] text-[var(--text-secondary)] shadow-[var(--shadow-1)] transition-transform hover:-translate-y-0.5 data-[active]:border-[var(--border-default)] data-[active]:text-[var(--accent)] data-[minimized]:opacity-70"
              onClick={() => {
                if (active) onMinimize(tab.id);
                else onActivate(tab.id);
              }}
            >
              <SurfaceIcon tab={tab} size={21} />
              <span
                aria-hidden="true"
                className="absolute -bottom-[6px] left-1/2 size-1 -translate-x-1/2 rounded-full bg-[var(--accent)]"
              />
            </button>
          );
          })}
        </div>
      </> : null}
      <DesktopUpdateButton collapsed />
    </nav>
  );
}
