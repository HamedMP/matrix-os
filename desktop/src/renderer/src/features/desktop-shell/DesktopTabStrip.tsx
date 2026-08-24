import { LayoutGrid, Minus, Monitor, X } from "lucide-react";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import SurfaceIcon from "./SurfaceIcon";

export default function DesktopTabStrip({
  tabs,
  surfaces,
  activeTabId,
  onActivate,
  onRestore,
  onMinimize,
  onClose,
  workspaceView,
  onShowDesktop,
  onOpenApps,
}: {
  tabs: Tab[];
  surfaces: Record<string, DesktopSurface>;
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onRestore: (tabId: string) => void;
  onMinimize: (tabId: string) => void;
  onClose: (tab: Tab) => void;
  workspaceView: "desktop" | "tabs";
  onShowDesktop: () => void;
  onOpenApps: () => void;
}) {
  const tabbed = tabs.filter((tab) => surfaces[tab.id]?.mode === "tab");
  return (
    <div
      role="tablist"
      aria-label="Workspace tabs"
      className="no-drag flex h-full min-w-0 flex-1 items-end gap-1 overflow-x-auto px-1 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <button
        type="button"
        role="tab"
        aria-label="Desktop"
        aria-selected={workspaceView === "desktop"}
        className="flex h-8 min-w-[120px] shrink-0 items-center gap-2 rounded-t-lg border px-2.5 text-xs outline-none transition-colors"
        style={{
          borderColor: workspaceView === "desktop" ? "var(--border-subtle)" : "transparent",
          borderBottomColor: workspaceView === "desktop" ? "var(--bg-app)" : "transparent",
          background: workspaceView === "desktop" ? "var(--bg-app)" : "transparent",
          color: workspaceView === "desktop" ? "var(--text-primary)" : "var(--text-secondary)",
        }}
        onClick={onShowDesktop}
      >
        <Monitor size={14} />
        <span>Desktop</span>
      </button>
      {tabbed.map((tab) => {
        const active = workspaceView === "tabs" && tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className="group flex h-8 min-w-[132px] max-w-[220px] items-center gap-2 rounded-t-lg border px-2.5 text-xs outline-none transition-colors"
            style={{
              borderColor: active ? "var(--border-subtle)" : "transparent",
              borderBottomColor: active ? "var(--bg-app)" : "transparent",
              background: active ? "var(--bg-app)" : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <button
              type="button"
              role="tab"
              aria-label={tab.title}
              aria-selected={active}
              className="flex min-w-0 flex-1 items-center gap-2 outline-none"
              onClick={() => onActivate(tab.id)}
              onDoubleClick={() => onRestore(tab.id)}
            >
              <SurfaceIcon tab={tab} size={14} />
              <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
            </button>
            <button
              type="button"
              aria-label={`Minimize ${tab.title} tab`}
              title={`Minimize ${tab.title}`}
              className="flex size-5 items-center justify-center rounded opacity-60 hover:bg-[var(--bg-hover)] hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onMinimize(tab.id);
              }}
            >
              <Minus size={12} />
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
              className="flex size-5 items-center justify-center rounded opacity-60 hover:bg-[var(--bg-hover)] hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="Open App Launcher"
        title="Open App Launcher"
        className="mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        onClick={onOpenApps}
      >
        <LayoutGrid size={14} />
      </button>
    </div>
  );
}
