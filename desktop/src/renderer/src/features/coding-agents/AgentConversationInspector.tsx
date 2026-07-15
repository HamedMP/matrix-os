import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type AgentConversationInspectorTab = "changes" | "terminal" | "preview" | "activity";

type InspectorCounts = Record<AgentConversationInspectorTab, number>;

interface AgentConversationInspectorProps {
  defaultTab: AgentConversationInspectorTab;
  changesFocusRequestId?: number;
  counts: InspectorCounts;
  toolbar: ReactNode;
  composer?: ReactNode;
  changes: ReactNode;
  terminal: ReactNode;
  preview: ReactNode;
  activity: ReactNode;
}

const TABS: Array<{
  id: AgentConversationInspectorTab;
  label: string;
}> = [
  { id: "changes", label: "Changes" },
  { id: "terminal", label: "Terminal" },
  { id: "preview", label: "Preview" },
  { id: "activity", label: "Activity" },
];

export function AgentConversationInspector({
  defaultTab,
  changesFocusRequestId = 0,
  counts,
  toolbar,
  composer,
  changes,
  terminal,
  preview,
  activity,
}: AgentConversationInspectorProps) {
  const [selectedTab, setSelectedTab] = useState<AgentConversationInspectorTab>(defaultTab);
  const instanceId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const content: Record<AgentConversationInspectorTab, ReactNode> = {
    changes,
    terminal,
    preview,
    activity,
  };

  // A focus request is a one-shot signal: react only to increments observed
  // after mount. A stale non-zero id from an earlier review selection must not
  // force the Changes pane onto a fresh inspector (e.g. after a runtime switch
  // to a computer without review support).
  const lastFocusRequestId = useRef(changesFocusRequestId);
  useEffect(() => {
    if (changesFocusRequestId === lastFocusRequestId.current) return;
    lastFocusRequestId.current = changesFocusRequestId;
    setSelectedTab("changes");
  }, [changesFocusRequestId]);

  function selectTab(index: number) {
    const tab = TABS[index];
    if (!tab) return;
    setSelectedTab(tab.id);
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      selectTab((index + 1) % TABS.length);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectTab((index - 1 + TABS.length) % TABS.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab(0);
    } else if (event.key === "End") {
      event.preventDefault();
      selectTab(TABS.length - 1);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="shrink-0 space-y-3 border-b px-4 pb-3 pt-4"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        {toolbar}
        {composer}
      </div>
      <div
        role="tablist"
        aria-label="Conversation tools"
        className="grid shrink-0 grid-cols-4 gap-1 border-b p-1.5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-secondary)" }}
      >
        {TABS.map((tab, index) => {
          const selected = tab.id === selectedTab;
          return (
            <button
              key={tab.id}
              ref={(node) => { tabRefs.current[index] = node; }}
              id={`${instanceId}-${tab.id}-tab`}
              type="button"
              role="tab"
              aria-label={`${tab.label} ${counts[tab.id]}`}
              aria-selected={selected}
              aria-controls={`${instanceId}-${tab.id}-panel`}
              tabIndex={selected ? 0 : -1}
              className="no-drag flex min-w-0 items-center justify-center gap-1 rounded-md border px-1 py-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{
                borderColor: selected ? "var(--border-default)" : "transparent",
                background: selected ? "var(--bg-elevated)" : "transparent",
                color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
              }}
              onClick={() => setSelectedTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <span className="truncate">{tab.label}</span>
              <span
                className="min-w-3.5 shrink-0 rounded-full px-0.5 text-center text-[9px] tabular-nums"
                style={{
                  background: selected ? "var(--accent-muted)" : "var(--bg-surface)",
                  color: selected ? "var(--accent)" : "var(--text-tertiary)",
                }}
              >
                {counts[tab.id]}
              </span>
            </button>
          );
        })}
      </div>
      {TABS.map((tab) => {
        const selected = tab.id === selectedTab;
        return (
          <div
            key={tab.id}
            id={`${instanceId}-${tab.id}-panel`}
            role="tabpanel"
            aria-labelledby={`${instanceId}-${tab.id}-tab`}
            tabIndex={selected ? 0 : -1}
            hidden={!selected}
            className="min-h-0 flex-1 overflow-y-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          >
            {content[tab.id]}
          </div>
        );
      })}
    </div>
  );
}
