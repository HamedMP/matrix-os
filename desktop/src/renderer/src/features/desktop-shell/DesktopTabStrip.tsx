import { LayoutGrid, RotateCcw, X } from "lucide-react";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import SurfaceIcon from "./SurfaceIcon";

export default function DesktopTabStrip({
  tabs,
  surfaces,
  activeTabId,
  onActivate,
  onRestore,
  onClose,
  onOpenApps,
}: {
  tabs: Tab[];
  surfaces: Record<string, DesktopSurface>;
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onRestore: (tabId: string) => void;
  onClose: (tab: Tab) => void;
  onOpenApps: () => void;
}) {
  const tabbed = tabs.filter((tab) => surfaces[tab.id]?.mode === "tab");
  if (tabbed.length === 0) return null;
  const activeTab = tabbed.find((tab) => tab.id === activeTabId);
  return (
    <div
      role="tablist"
      aria-label="Workspace tabs"
      className="no-drag flex h-full min-w-0 flex-1 items-end gap-1 overflow-x-auto px-1 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabbed.map((tab) => {
        const active = tab.id === activeTabId;
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
        className="mb-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
        onClick={onOpenApps}
      >
        <LayoutGrid size={14} />
      </button>
      {activeTab ? (
        <div className="no-drag sticky right-1 mb-0.5 ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label={`Close ${activeTab.title} workspace`}
            className="flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] text-[var(--text-primary)] shadow-[var(--shadow-1)]"
            style={{
              borderColor: "color-mix(in srgb, var(--matrix-window-close) 65%, var(--border-subtle))",
              background: "color-mix(in srgb, var(--matrix-window-close) 18%, var(--bg-surface))",
            }}
            onClick={() => onClose(activeTab)}
          >
            <span className="size-2 rounded-full" style={{ background: "var(--matrix-window-close)" }} />
            <X size={11} /> Close
          </button>
          <button
            type="button"
            aria-label={`Restore ${activeTab.title} as window`}
            className="flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] text-[var(--text-secondary)] shadow-[var(--shadow-1)] hover:text-[var(--text-primary)]"
            style={{
              borderColor: "color-mix(in srgb, var(--matrix-window-maximize) 65%, var(--border-subtle))",
              background: "var(--bg-surface)",
            }}
            onClick={() => onRestore(activeTab.id)}
          >
            <span className="size-2 rounded-full" style={{ background: "var(--matrix-window-maximize)" }} />
            <RotateCcw size={12} /> Restore window
          </button>
        </div>
      ) : null}
    </div>
  );
}
