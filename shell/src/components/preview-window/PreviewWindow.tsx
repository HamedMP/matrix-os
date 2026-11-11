"use client";

import { ShellFileAuthority } from "@/components/file-browser/ShellFileAuthority";
import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { useWindowManager } from "@/hooks/useWindowManager";
import { isEditablePreviewTab, PreviewTabContent } from "./PreviewTab";
import { cn } from "@/lib/utils";
import { XIcon } from "@/lib/hugeicons";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

const MAX_DIRTY_EDITORS = 3;

export function PreviewWindow() {
  return <ShellFileAuthority>{authority => <PreviewWindowForAuthority key={authority} authority={authority} />}</ShellFileAuthority>;
}

function PreviewWindowForAuthority({ authority }: { authority: string }) {
  const allTabs = usePreviewWindow((s) => s.tabs);
  const tabs = allTabs.filter(tab => tab.authority === authority);
  const activeTabId = usePreviewWindow((s) => s.activeTabId);
  const pendingFocusTabId = usePreviewWindow((s) => s.pendingFocusTabId);
  const foreground = useWindowManager((s) => s.getFocusedWindow()?.path === "__preview-window__");
  const activeTabRef = useRef<HTMLDivElement>(null);
  // Drafts live in mounted editors. Do not retain a tab or block a new editor
  // based on a dirty flag from a prior preview window or authority.
  const [dirtyEditors, setDirtyEditors] = useState<Set<string>>(() => new Set());
  const setActiveTab = usePreviewWindow((s) => s.setActiveTab);
  const closeTab = usePreviewWindow((s) => s.closeTab);

  function updateDirtyEditor(id: string, dirty: boolean) {
    setDirtyEditors(current => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function closeEditor(id: string) {
    updateDirtyEditor(id, false);
    closeTab(id);
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs.at(-1);
  const visibleTabId = activeTab?.id;
  useLayoutEffect(() => {
    const element = activeTabRef.current;
    if (!foreground || !pendingFocusTabId || visibleTabId !== pendingFocusTabId || !element) return;
    element.focus({ preventScroll: true });
    usePreviewWindow.getState().consumeTabFocus(pendingFocusTabId);
  }, [foreground, pendingFocusTabId, visibleTabId]);

  const dirtyTabs = tabs.filter(tab => dirtyEditors.has(tab.id));
  const editorLimitReached = activeTab && isEditablePreviewTab(activeTab)
    && !dirtyEditors.has(activeTab.id) && dirtyTabs.length >= MAX_DIRTY_EDITORS;

  if (tabs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <div className="text-lg mb-1">No files open</div>
          <div className="text-xs">
            Double-click a file in the file browser to open it here
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center border-b overflow-x-auto shrink-0" role="tablist">
        {tabs.map((tab, i) => {
          const active = tab.id === activeTab?.id;
          const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.target !== e.currentTarget) return;

            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setActiveTab(tab.id);
              return;
            }

            const keyToIndex: Record<string, number> = {
              ArrowLeft: i === 0 ? tabs.length - 1 : i - 1,
              ArrowRight: i === tabs.length - 1 ? 0 : i + 1,
              Home: 0,
              End: tabs.length - 1,
            };
            const nextIndex = keyToIndex[e.key];
            const nextTab = tabs[nextIndex];
            if (!nextTab) return;

            e.preventDefault();
            setActiveTab(nextTab.id);
            const tabElements = Array.from(
              e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
            );
            tabElements[nextIndex]?.focus();
          };
          return (
            <div
              key={tab.id}
              ref={active ? activeTabRef : undefined}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-default border-r select-none min-w-0 shrink-0",
                "hover:bg-accent/30 transition-colors",
                active && "bg-background border-b-2 border-b-primary",
              )}
              onClick={() => setActiveTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeEditor(tab.id);
              }}
              onKeyDown={handleTabKeyDown}
            >
              {dirtyEditors.has(tab.id) && (
                <span className="size-1.5 rounded-full bg-amber-400 shrink-0" />
              )}
              <span className="truncate max-w-32">{tab.name}</span>
              <button
                type="button"
                className="size-4 rounded hover:bg-accent flex items-center justify-center shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  closeEditor(tab.id);
                }}
              >
                <XIcon className="size-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-h-0">
        {editorLimitReached && (
          <p role="status" className="flex h-full items-center justify-center p-3 text-sm text-muted-foreground">
            Save or close an edited file to open another editor.
          </p>
        )}
        {tabs.filter(tab => dirtyEditors.has(tab.id) || (!editorLimitReached && tab.id === activeTab?.id)).map(tab => (
          <div key={tab.id} hidden={tab.id !== activeTab?.id} className="h-full">
            <PreviewTabContent tab={tab} onDirtyChange={updateDirtyEditor} />
          </div>
        ))}
      </div>
    </div>
  );
}
