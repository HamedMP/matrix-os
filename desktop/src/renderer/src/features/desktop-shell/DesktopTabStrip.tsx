import { LayoutGrid, RotateCcw, X } from "lucide-react";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import SurfaceIcon from "./SurfaceIcon";
import { DESKTOP_Z_INDEX, NATIVE_DESKTOP_LAYOUT } from "../../design/layering";

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
  return (
    <div
      role="tablist"
      aria-label="Workspace tabs"
      className="absolute inset-x-0 top-0 flex items-end gap-1 overflow-x-auto border-b px-2 pt-1.5"
      style={{
        zIndex: DESKTOP_Z_INDEX.nativeDesktopTabStrip,
        height: `${NATIVE_DESKTOP_LAYOUT.tabStripHeight}px`,
        borderColor: "var(--border-subtle)",
        background: "var(--bg-sunken)",
      }}
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
              className="flex size-4 items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-hover)]"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab);
              }}
            >
              <X size={10} />
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
      {activeTabId && surfaces[activeTabId]?.mode === "tab" ? (
        <button
          type="button"
          aria-label={`Restore ${tabs.find((tab) => tab.id === activeTabId)?.title ?? "tab"} as window`}
          className="no-drag sticky right-2 mb-0.5 ml-auto flex h-7 shrink-0 items-center gap-1.5 rounded-md border bg-[var(--bg-surface)] px-2 text-[11px] text-[var(--text-secondary)] shadow-[var(--shadow-1)] hover:text-[var(--text-primary)]"
          style={{ borderColor: "var(--border-subtle)" }}
          onClick={() => onRestore(activeTabId)}
        >
          <RotateCcw size={12} /> Restore window
        </button>
      ) : null}
    </div>
  );
}
