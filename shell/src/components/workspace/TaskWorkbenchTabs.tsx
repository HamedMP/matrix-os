"use client";

import type { TaskWorkbenchTab } from "@/stores/task-workbench";

export function TaskWorkbenchTabs({
  tabs,
  activeTabId,
  onActivate,
}: {
  tabs: TaskWorkbenchTab[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex min-h-10 items-center gap-1 overflow-x-auto border-b border-border bg-background px-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onActivate(tab.id)}
          className={`h-8 shrink-0 rounded-md border px-3 text-xs ${tab.id === activeTabId ? "border-primary bg-accent" : "border-border hover:bg-accent/60"}`}
        >
          {tab.title}
        </button>
      ))}
    </div>
  );
}
