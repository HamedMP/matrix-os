import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { LucideIcon } from "lucide-react";

export interface InspectorTabDefinition<TTab extends string> {
  id: TTab;
  label: string;
  icon: LucideIcon;
  count?: number;
  content: ReactNode;
}

interface InspectorTabSelectionRequest<TTab extends string> {
  id: number;
  consumedId: number;
  tab: TTab;
  onConsumed?: (requestId: number) => void;
}

interface InspectorTabShellProps<TTab extends string> {
  ariaLabel: string;
  tabs: readonly InspectorTabDefinition<TTab>[];
  defaultTab: TTab;
  selectedTab?: TTab;
  onTabChange?: (tab: TTab) => void;
  selectionRequest?: InspectorTabSelectionRequest<TTab>;
  header?: ReactNode;
}

const TAB_LABEL_MIN_WIDTH_PX = 96;

export function InspectorTabShell<TTab extends string>({
  ariaLabel,
  tabs,
  defaultTab,
  selectedTab: controlledTab,
  onTabChange,
  selectionRequest,
  header,
}: InspectorTabShellProps<TTab>) {
  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const safeDefaultTab = tabIds.includes(defaultTab) ? defaultTab : tabIds[0]!;
  const [internalTab, setInternalTab] = useState<TTab>(safeDefaultTab);
  const requestedTab = controlledTab ?? internalTab;
  const selectedTab = tabIds.includes(requestedTab) ? requestedTab : safeDefaultTab;
  const instanceId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const [labelsVisible, setLabelsVisible] = useState(false);
  const [visitedTabs, setVisitedTabs] = useState<TTab[]>(() => [safeDefaultTab]);
  const visitedTabSet = useMemo(() => new Set(visitedTabs), [visitedTabs]);

  useEffect(() => {
    if (controlledTab === undefined || !tabIds.includes(controlledTab)) return;
    setVisitedTabs((current) => current.includes(controlledTab) ? current : [...current, controlledTab]);
  }, [controlledTab, tabIds]);

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

  function selectTab(tab: TTab, focusIndex?: number) {
    setVisitedTabs((current) => current.includes(tab) ? current : [...current, tab]);
    if (controlledTab === undefined) setInternalTab(tab);
    onTabChange?.(tab);
    if (focusIndex !== undefined) tabRefs.current[focusIndex]?.focus();
  }

  useEffect(() => {
    if (!selectionRequest || selectionRequest.id <= selectionRequest.consumedId) return;
    selectionRequest.onConsumed?.(selectionRequest.id);
    if (tabIds.includes(selectionRequest.tab)) selectTab(selectionRequest.tab);
    // The request is an explicit one-shot signal. Re-running on incidental
    // callback identity changes would incorrectly steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionRequest?.consumedId, selectionRequest?.id]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    selectTab(tabs[nextIndex]!.id, nextIndex);
  }

  return (
    <RadixTooltip.Provider delayDuration={400}>
      <div className="flex min-h-0 flex-1 flex-col">
        {header ? (
          <div
            className="shrink-0 border-b px-4 pb-3 pt-4"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            {header}
          </div>
        ) : null}
        <div
          ref={tablistRef}
          role="tablist"
          aria-label={ariaLabel}
          className="grid shrink-0 gap-1 border-b p-1.5"
          style={{
            gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
            borderColor: "var(--border-subtle)",
            background: "var(--bg-sunken)",
          }}
        >
          {tabs.map((tab, index) => {
            const selected = tab.id === selectedTab;
            const TabIcon = tab.icon;
            return (
              <RadixTooltip.Root key={tab.id}>
                <RadixTooltip.Trigger asChild>
                  <button
                    ref={(node) => { tabRefs.current[index] = node; }}
                    id={`${instanceId}-${tab.id}-tab`}
                    type="button"
                    role="tab"
                    aria-label={tab.count === undefined ? tab.label : `${tab.label} ${tab.count}`}
                    aria-selected={selected}
                    aria-controls={`${instanceId}-${tab.id}-panel`}
                    tabIndex={selected ? 0 : -1}
                    className="no-drag flex min-w-0 items-center justify-center gap-1.5 overflow-hidden rounded-md border px-2 py-2 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    style={{
                      borderColor: selected ? "var(--border-default)" : "transparent",
                      background: selected ? "var(--bg-raised)" : "transparent",
                      color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
                    }}
                    onClick={() => selectTab(tab.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    <TabIcon size={14} className="shrink-0" aria-hidden="true" />
                    {labelsVisible ? <span className="whitespace-nowrap">{tab.label}</span> : null}
                    {tab.count === undefined ? null : (
                      <span
                        className="min-w-3.5 shrink-0 rounded-full px-0.5 text-center text-[9px] tabular-nums"
                        style={{
                          background: selected ? "var(--accent-muted)" : "var(--bg-surface)",
                          color: selected ? "var(--accent)" : "var(--text-tertiary)",
                        }}
                      >
                        {tab.count}
                      </span>
                    )}
                  </button>
                </RadixTooltip.Trigger>
                <RadixTooltip.Portal>
                  <RadixTooltip.Content
                    sideOffset={6}
                    className="z-[100] rounded-md px-2 py-1 text-xs"
                    style={{
                      background: "var(--forest-deep)",
                      color: "var(--forest-foreground)",
                      boxShadow: "var(--shadow-2)",
                    }}
                  >
                    {tab.label}
                  </RadixTooltip.Content>
                </RadixTooltip.Portal>
              </RadixTooltip.Root>
            );
          })}
        </div>
        {tabs.map((tab) => {
          const selected = tab.id === selectedTab;
          return (
            <div
              key={tab.id}
              id={`${instanceId}-${tab.id}-panel`}
              role="tabpanel"
              aria-labelledby={`${instanceId}-${tab.id}-tab`}
              tabIndex={selected ? 0 : -1}
              hidden={!selected}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            >
              {selected || visitedTabSet.has(tab.id) ? (
                <div className="flex min-h-0 flex-1 flex-col p-4">{tab.content}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </RadixTooltip.Provider>
  );
}
