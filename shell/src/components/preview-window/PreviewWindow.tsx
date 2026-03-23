"use client";

import { usePreviewWindow } from "@/hooks/usePreviewWindow";
import { PreviewTabContent } from "./PreviewTab";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";

export function PreviewWindow() {
  const tabs = usePreviewWindow((s) => s.tabs);
  const activeTabId = usePreviewWindow((s) => s.activeTabId);
  const unsavedTabs = usePreviewWindow((s) => s.unsavedTabs);
  const setActiveTab = usePreviewWindow((s) => s.setActiveTab);
  const closeTab = usePreviewWindow((s) => s.closeTab);

  const activeTab = tabs.find((t) => t.id === activeTabId);

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
      <div className="flex items-center border-b overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs cursor-default border-r select-none min-w-0 shrink-0",
              "hover:bg-accent/30 transition-colors",
              tab.id === activeTabId &&
                "bg-background border-b-2 border-b-primary",
            )}
            onClick={() => setActiveTab(tab.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(tab.id);
            }}
          >
            {unsavedTabs.has(tab.id) && (
              <span className="size-1.5 rounded-full bg-amber-400 shrink-0" />
            )}
            <span className="truncate max-w-32">{tab.name}</span>
            <button
              className="size-4 rounded hover:bg-accent flex items-center justify-center shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex-1 min-h-0">
        {activeTab && <PreviewTabContent tab={activeTab} />}
      </div>
    </div>
  );
}
