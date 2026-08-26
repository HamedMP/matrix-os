import { useEffect, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X } from "lucide-react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { DesktopSurface } from "../../stores/desktop-surfaces";
import type { Tab } from "../../stores/tabs";
import DesktopAppIcon from "./DesktopAppIcon";
import { desktopAppAppearance } from "./desktop-apps";
import SurfaceIcon from "./SurfaceIcon";

function activateFromKeyboard(event: ReactKeyboardEvent<HTMLDivElement>, onActivate: () => void) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onActivate();
  }
}

function PreviewTile({
  tab,
  onActivate,
  onClose,
}: {
  tab: Tab;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Preview ${tab.title}`}
      className="group relative h-[171px] w-[219px] shrink-0 overflow-hidden rounded-[6px] border border-[var(--border-default)] bg-[var(--bg-app)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      onClick={onActivate}
      onKeyDown={(event) => activateFromKeyboard(event, onActivate)}
    >
      <div data-testid="desktop-preview-icon-tile" className="flex size-full items-center justify-center bg-[var(--bg-app)] p-4">
        <DesktopAppIcon
          name={tab.title}
          icon={<SurfaceIcon tab={tab} size={36} />}
          {...desktopAppAppearance(tab.kind)}
          className="relative size-18 rounded-[24px] border border-[var(--border-subtle)] shadow-[var(--shadow-2)]"
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-[color-mix(in_srgb,var(--bg-app)_96%,transparent)] to-transparent px-2 pb-2 pt-8">
        <SurfaceIcon tab={tab} size={12} />
        <span className="min-w-0 truncate text-xs text-[var(--text-primary)]">{tab.title}</span>
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/32 text-xs font-medium text-[var(--text-inverse,#FAF9F7)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        Go to app
      </div>
      <button
        type="button"
        aria-label={`Close ${tab.title} preview`}
        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-[4.8px] text-[var(--text-primary)] opacity-0 transition-colors group-hover:opacity-100 hover:bg-[var(--bg-hover)] focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        style={{
          background: "var(--surface-primary, #FFFEFC)",
          border: "0.8px solid var(--border-default, #F3F2F2)",
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        <X size={14} strokeWidth={1.7} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function DesktopAppDrawer({
  open,
  tabs,
  surfaces,
  onClose,
  onActivate,
  onCloseTab,
}: {
  open: boolean;
  tabs: Tab[];
  surfaces: Record<string, DesktopSurface>;
  onClose: () => void;
  onActivate: (tabId: string) => void;
  onCloseTab: (tab: Tab) => void;
}) {
  const openTabs = tabs.filter((tab) => surfaces[tab.id]?.mode !== "closed" && surfaces[tab.id] !== undefined);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  return (
    <div
      className={`absolute inset-0 ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      data-state={open ? "open" : "closed"}
      data-testid="desktop-app-drawer-layer"
    >
      <div
        aria-hidden="true"
        data-testid="desktop-app-drawer-backdrop"
        className={`absolute inset-0 bg-black/10 backdrop-blur-[1px] ${open ? "opacity-100" : "opacity-0"}`}
        style={{
          zIndex: DESKTOP_Z_INDEX.nativeDesktopDrawerBackdrop,
          transition: "opacity 180ms ease-out",
        }}
        onPointerDown={onClose}
      />
      <aside
        role="dialog"
        aria-label="All open apps"
        aria-modal="true"
        aria-hidden={!open}
        className="absolute inset-y-0 left-0 flex w-[240px] flex-col border-r border-[var(--border-default)] bg-[color-mix(in_srgb,var(--bg-app)_63%,transparent)] shadow-lg backdrop-blur-md"
        style={{
          zIndex: DESKTOP_Z_INDEX.nativeDesktopDrawer,
          opacity: open ? 1 : 0,
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 220ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease-out",
        }}
      >
        <header className="flex items-center justify-between px-3 py-3">
          <h2 className="text-xs font-medium text-[var(--text-secondary)]">All open apps</h2>
          <button type="button" aria-label="Close all open apps" className="flex size-6 items-center justify-center rounded hover:bg-[var(--bg-hover)]" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 pb-3">
          {openTabs.map((tab) => (
            <PreviewTile
              key={tab.id}
              tab={tab}
              onActivate={() => onActivate(tab.id)}
              onClose={() => onCloseTab(tab)}
            />
          ))}
        </div>
      </aside>
    </div>
  );
}
