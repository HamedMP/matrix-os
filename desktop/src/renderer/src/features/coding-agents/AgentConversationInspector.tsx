import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { Activity, FileDiff, FolderOpen, Globe, SquareTerminal, type LucideIcon } from "lucide-react";

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
  tabs?: readonly AgentConversationInspectorTab[];
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

const TAB_ICONS: Record<AgentConversationInspectorTab, LucideIcon> = {
  changes: FileDiff,
  files: FolderOpen,
  terminal: SquareTerminal,
  preview: Globe,
  activity: Activity,
};

// Tabs are icon-first: a tab shows its full label only when the tablist is
// wide enough for every tab to carry icon + label + badge without truncation
// (~96px per tab). Below that the icon and count badge stand alone and the
// tooltip carries the name — labels never ellipsis.
const TAB_LABEL_MIN_WIDTH_PX = 96;

export function AgentConversationInspector({
  defaultTab,
  tabs: requestedTabs,
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
  const defaultTabs: AgentConversationInspectorTab[] = files === undefined
    ? ["changes", "terminal", "preview", "activity"]
    : ["changes", "files", "terminal", "preview", "activity"];
  const tabs = requestedTabs && requestedTabs.length > 0 ? [...requestedTabs] : defaultTabs;
  const safeDefaultTab = tabs.includes(defaultTab) ? defaultTab : tabs[0]!;
  const [internalTab, setInternalTab] = useState<AgentConversationInspectorTab>(safeDefaultTab);
  const requestedSelectedTab = controlledTab ?? internalTab;
  const selectedTab = tabs.includes(requestedSelectedTab) ? requestedSelectedTab : safeDefaultTab;
  const instanceId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  // Icon-only until the tablist proves it has room for full labels.
  const [labelsVisible, setLabelsVisible] = useState(false);

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
  const [visitedTabs, setVisitedTabs] = useState<AgentConversationInspectorTab[]>(() =>
    controlledTab !== undefined
      && controlledTab !== safeDefaultTab
      && tabs.includes(controlledTab)
      ? [safeDefaultTab, controlledTab]
      : [safeDefaultTab],
  );
  const visitedTabSet = useMemo(() => new Set(visitedTabs), [visitedTabs]);

  // Labels appear only when every tab fits icon + label + badge; otherwise
  // the tabs stay icon-first with tooltips carrying the names.
  useEffect(() => {
    const node = tablistRef.current;
    if (!node || typeof ResizeObserver !== "function") return undefined;
    const threshold = tabs.length * TAB_LABEL_MIN_WIDTH_PX;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      setLabelsVisible(width >= threshold);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tabs.length]);

  function selectTab(tab: AgentConversationInspectorTab, focusIndex?: number) {
    setVisitedTabs((current) => current.includes(tab) ? current : [...current, tab]);
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
    if (tabs.includes("changes")) selectTab("changes");
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
    <RadixTooltip.Provider delayDuration={400}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="shrink-0 space-y-3 border-b px-4 pb-3 pt-4"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          {toolbar}
          {composer}
        </div>
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Conversation tools"
          className="grid shrink-0 gap-1 border-b p-1.5"
          style={{
            gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
            borderColor: "var(--border-subtle)",
            background: "var(--bg-sunken)",
          }}
        >
        {tabs.map((tabId, index) => {
          const selected = tabId === selectedTab;
          const label = TAB_LABELS[tabId];
          const TabIcon = TAB_ICONS[tabId];
          // Surfaces without a meaningful count (the file browser) render no
          // badge rather than a permanent zero.
          const count = counts[tabId];
          return (
            <RadixTooltip.Root key={tabId}>
              <RadixTooltip.Trigger asChild>
                <button
                  ref={(node) => { tabRefs.current[index] = node; }}
                  id={`${instanceId}-${tabId}-tab`}
                  type="button"
                  role="tab"
                  aria-label={count === undefined ? label : `${label} ${count}`}
                  aria-selected={selected}
                  aria-controls={`${instanceId}-${tabId}-panel`}
                  tabIndex={selected ? 0 : -1}
                  className="no-drag flex min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border px-2 py-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  style={{
                    borderColor: selected ? "var(--border-default)" : "transparent",
                    background: selected ? "var(--bg-raised)" : "transparent",
                    color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
                  }}
                  onClick={() => selectTab(tabId)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <TabIcon size={14} className="shrink-0" aria-hidden="true" />
                  {labelsVisible ? <span className="whitespace-nowrap">{label}</span> : null}
                  {count === undefined ? null : (
                    <span
                      className="min-w-3.5 shrink-0 rounded-full px-0.5 text-center text-[9px] tabular-nums"
                      style={{
                        background: selected ? "var(--accent-muted)" : "var(--bg-surface)",
                        color: selected ? "var(--accent)" : "var(--text-tertiary)",
                      }}
                    >
                      {count}
                    </span>
                  )}
                </button>
              </RadixTooltip.Trigger>
              <RadixTooltip.Portal>
                <RadixTooltip.Content
                  sideOffset={6}
                  className="z-[100] rounded-md px-2 py-1 text-xs"
                  style={{ background: "var(--forest-deep)", color: "var(--forest-foreground)", boxShadow: "var(--shadow-2)" }}
                >
                  {label}
                </RadixTooltip.Content>
              </RadixTooltip.Portal>
            </RadixTooltip.Root>
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
              {selected || visitedTabSet.has(tabId) ? (
                <div className="flex min-h-0 flex-1 flex-col p-4">{content[tabId]}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </RadixTooltip.Provider>
  );
}
