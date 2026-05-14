"use client";

import { XIcon } from "lucide-react";
import type { TaskWorkbenchTab } from "@/stores/task-workbench";

export function TaskWorkbenchTabs({
  tabs,
  activeTabId,
  onActivate,
  onClose,
}: {
  tabs: TaskWorkbenchTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose?: (tabId: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex min-h-10 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex h-8 shrink-0 items-center rounded-md border text-xs ${tab.id === activeTabId ? "border-primary bg-accent" : "border-border hover:bg-accent/60"}`}
        >
          <button
            type="button"
            onClick={() => onActivate(tab.id)}
            className="h-full max-w-40 truncate px-3"
          >
            {tab.title}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={() => onClose(tab.id)}
              className="flex size-7 items-center justify-center border-l border-border text-muted-foreground hover:text-foreground"
              aria-label={`Close ${tab.title}`}
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
