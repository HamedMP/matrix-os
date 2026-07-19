import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export type AgentConversationInspectorTab = "changes" | "files" | "terminal" | "preview" | "activity";

interface InspectorCounts {
  changes: number;
  terminal: number;
  preview: number;
  activity: number;
  files?: number;
}

interface AgentConversationInspectorProps {
  defaultTab: AgentConversationInspectorTab;
  // Optional controlled selection. When both are provided the parent owns the
  // active tab (e.g. to gate live resources like an embedded terminal socket
  // on the Terminal surface being visible).
  selectedTab?: AgentConversationInspectorTab;
  onTabChange?: (tab: AgentConversationInspectorTab) => void;
  changesFocusRequestId?: number;
  changesFocusConsumedId?: number;
  onChangesFocusConsumed?: (requestId: number) => void;
  counts: InspectorCounts;
  toolbar: ReactNode;
  composer?: ReactNode;
  changes: ReactNode;
  // Optional surface rendered as a tab between Changes and Terminal when
  // provided; omitted entirely otherwise so existing four-tab layouts keep
  // their tab order and keyboard navigation.
  files?: ReactNode;
  terminal: ReactNode;
  preview: ReactNode;
  activity: ReactNode;
}

const TAB_LABELS: Record<AgentConversationInspectorTab, string> = {
  changes: "Changes",
  files: "Files",
  terminal: "Terminal",
  preview: "Preview",
  activity: "Activity",
};

export function AgentConversationInspector({
  defaultTab,
  selectedTab: controlledTab,
  onTabChange,
  changesFocusRequestId = 0,
  changesFocusConsumedId = 0,
  onChangesFocusConsumed,
  counts,
  toolbar,
  composer,
  changes,
  files,
  terminal,
  preview,
  activity,
}: AgentConversationInspectorProps) {
  const [internalTab, setInternalTab] = useState<AgentConversationInspectorTab>(defaultTab);
  const selectedTab = controlledTab ?? internalTab;
  const instanceId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const tabs: AgentConversationInspectorTab[] = files === undefined
    ? ["changes", "terminal", "preview", "activity"]
    : ["changes", "files", "terminal", "preview", "activity"];
  const content: Record<AgentConversationInspectorTab, ReactNode> = {
    changes,
    files,
    terminal,
    preview,
    activity,
  };

  // Lazy-mount surfaces on first visit so a never-opened tab (file listings,
  // live previews) costs nothing; once visited a surface stays mounted across
  // switches so local state (drafts, scrollback, selection) survives.
  const [visitedTabs, setVisitedTabs] = useState<AgentConversationInspectorTab[]>([defaultTab]);
  if (!visitedTabs.includes(selectedTab)) {
    setVisitedTabs([...visitedTabs, selectedTab]);
  }

  function selectTab(tab: AgentConversationInspectorTab, focusIndex?: number) {
    if (controlledTab === undefined) setInternalTab(tab);
    onTabChange?.(tab);
    if (focusIndex !== undefined) tabRefs.current[focusIndex]?.focus();
  }

  // A focus request is a one-shot signal consumed exactly once, tracked by the
  // owner via the consumed marker. That honors a request raised before this
  // inspector mounts (the command palette selects a review, then opens the
  // Agents tab) while an already-consumed id cannot re-force the Changes pane
  // on later remounts, and the runtime-switch reset to zero is not a request.
  useEffect(() => {
    if (changesFocusRequestId <= changesFocusConsumedId) return;
    onChangesFocusConsumed?.(changesFocusRequestId);
    selectTab("changes");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesFocusConsumedId, changesFocusRequestId, onChangesFocusConsumed]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = (index + 1) % tabs.length;
      selectTab(tabs[next]!, next);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const next = (index - 1 + tabs.length) % tabs.length;
      selectTab(tabs[next]!, next);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectTab(tabs[0]!, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = tabs.length - 1;
      selectTab(tabs[last]!, last);
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
        className="grid shrink-0 gap-1 border-b p-1.5"
        style={{
          gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
          borderColor: "var(--border-subtle)",
          background: "var(--bg-secondary)",
        }}
      >
        {tabs.map((tabId, index) => {
          const selected = tabId === selectedTab;
          const label = TAB_LABELS[tabId];
          return (
            <button
              key={tabId}
              ref={(node) => { tabRefs.current[index] = node; }}
              id={`${instanceId}-${tabId}-tab`}
              type="button"
              role="tab"
              aria-label={`${label} ${counts[tabId] ?? 0}`}
              aria-selected={selected}
              aria-controls={`${instanceId}-${tabId}-panel`}
              tabIndex={selected ? 0 : -1}
              className="no-drag flex min-w-0 items-center justify-center gap-1 rounded-md border px-1 py-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{
                borderColor: selected ? "var(--border-default)" : "transparent",
                background: selected ? "var(--bg-elevated)" : "transparent",
                color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
              }}
              onClick={() => selectTab(tabId)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              <span className="truncate">{label}</span>
              <span
                className="min-w-3.5 shrink-0 rounded-full px-0.5 text-center text-[9px] tabular-nums"
                style={{
                  background: selected ? "var(--accent-muted)" : "var(--bg-surface)",
                  color: selected ? "var(--accent)" : "var(--text-tertiary)",
                }}
              >
                {counts[tabId] ?? 0}
              </span>
            </button>
          );
        })}
      </div>
      {tabs.map((tabId) => {
        const selected = tabId === selectedTab;
        return (
          <div
            key={tabId}
            id={`${instanceId}-${tabId}-panel`}
            role="tabpanel"
            aria-labelledby={`${instanceId}-${tabId}-tab`}
            tabIndex={selected ? 0 : -1}
            hidden={!selected}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          >
            {visitedTabs.includes(tabId) ? (
              <div className="flex min-h-0 flex-1 flex-col p-4">{content[tabId]}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
