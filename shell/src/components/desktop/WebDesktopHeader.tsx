"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppWindow } from "@/hooks/useWindowManager";
import { Monitor, PanelLeft, X } from "@/lib/hugeicons";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

interface WebDesktopHeaderProps {
  windows: AppWindow[];
  fullscreenWindowId: string | null;
  renderWindowIcon: (windowRecord: AppWindow, large?: boolean) => ReactNode;
  onActivateWindow: (id: string) => void;
  onCloseWindow: (id: string) => void;
  onShowDesktop: () => void;
  onToggleFullscreen: (id: string) => void;
}

function activeWindowId(windows: AppWindow[]): string | null {
  let active: AppWindow | null = null;
  for (const windowRecord of windows) {
    if (windowRecord.minimized) continue;
    if (!active || windowRecord.zIndex > active.zIndex) active = windowRecord;
  }
  return active?.id ?? null;
}

export function WebDesktopHeader({
  windows,
  fullscreenWindowId,
  renderWindowIcon,
  onActivateWindow,
  onCloseWindow,
  onShowDesktop,
  onToggleFullscreen,
}: WebDesktopHeaderProps) {
  const [previewsOpen, setPreviewsOpen] = useState(false);
  const activeId = useMemo(() => activeWindowId(windows), [windows]);
  const fullscreenWindow = windows.find((windowRecord) => windowRecord.id === fullscreenWindowId);

  useEffect(() => {
    if (!previewsOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [previewsOpen]);

  return (
    <>
      <header
        data-web-desktop-header
        className="pointer-events-auto absolute inset-x-0 top-0 flex h-[38px] items-stretch border-b border-border/70 bg-card/78 text-foreground shadow-[0_1px_0_rgba(255,255,255,0.45)] backdrop-blur-[68px]"
        style={{ zIndex: SHELL_Z_INDEX.desktopHeader }}
      >
        <div role="tablist" aria-label="Workspace tabs" className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            type="button"
            role="tab"
            aria-label="Open app previews"
            aria-selected={previewsOpen}
            title="Open app previews"
            className="flex w-[44px] shrink-0 items-center justify-center border-r border-border/70 text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground aria-selected:bg-card aria-selected:text-foreground focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-primary"
            onClick={() => setPreviewsOpen((open) => !open)}
          >
            <PanelLeft className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            role="tab"
            aria-label="Show desktop"
            aria-selected={activeId === null}
            title="Show desktop"
            className="flex w-[44px] shrink-0 items-center justify-center border-r border-border/70 text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground aria-selected:bg-card aria-selected:text-foreground focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-primary"
            onClick={onShowDesktop}
          >
            <Monitor className="size-3.5" aria-hidden="true" />
          </button>
          {fullscreenWindow ? (
            <button
              type="button"
              role="tab"
              aria-label={fullscreenWindow.title}
              aria-selected={true}
              className="flex min-w-[132px] max-w-[220px] shrink-0 items-center gap-2 border-r border-border/70 px-3 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground aria-selected:bg-card aria-selected:text-foreground focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-primary"
              onClick={() => onActivateWindow(fullscreenWindow.id)}
              onDoubleClick={() => onToggleFullscreen(fullscreenWindow.id)}
            >
              <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                {renderWindowIcon(fullscreenWindow)}
              </span>
              <span className="min-w-0 flex-1 truncate">{fullscreenWindow.title}</span>
            </button>
          ) : null}
        </div>
      </header>

      {previewsOpen ? (
        <div
          className="pointer-events-auto absolute inset-x-0 bottom-0 top-[38px]"
          style={{ zIndex: SHELL_Z_INDEX.desktopDrawerBackdrop }}
        >
          <button
            type="button"
            aria-label="Close app previews"
            className="absolute inset-0 size-full cursor-default bg-black/10 backdrop-blur-[1px]"
            onClick={() => setPreviewsOpen(false)}
          />
          <aside
            role="dialog"
            aria-label="Open apps"
            aria-modal="true"
            className="absolute inset-y-0 left-0 flex w-[248px] flex-col border-r border-border bg-card/82 shadow-2xl backdrop-blur-2xl"
            style={{ zIndex: SHELL_Z_INDEX.desktopDrawer }}
          >
            <header className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-3">
              <h2 className="text-xs font-medium text-muted-foreground">Open apps</h2>
              <button
                type="button"
                aria-label="Close app previews"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                onClick={() => setPreviewsOpen(false)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
              {windows.length === 0 ? (
                <p className="px-2 py-8 text-center text-xs text-muted-foreground">No apps are open.</p>
              ) : windows.map((windowRecord) => (
                <div
                  key={windowRecord.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Preview ${windowRecord.title}`}
                  className="group relative flex h-[146px] shrink-0 cursor-default items-center justify-center overflow-hidden rounded-lg border border-border bg-background/80 shadow-sm outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() => {
                    onActivateWindow(windowRecord.id);
                    setPreviewsOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onActivateWindow(windowRecord.id);
                    setPreviewsOpen(false);
                  }}
                >
                  {renderWindowIcon(windowRecord, true)}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-background via-background/90 to-transparent px-3 pb-2 pt-8">
                    <span className="flex size-4 items-center justify-center" aria-hidden="true">{renderWindowIcon(windowRecord)}</span>
                    <span className="min-w-0 truncate text-xs font-medium text-foreground">{windowRecord.title}</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Close ${windowRecord.title} preview`}
                    className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-md bg-card/90 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:bg-red-500/10 hover:text-red-600 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseWindow(windowRecord.id);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
