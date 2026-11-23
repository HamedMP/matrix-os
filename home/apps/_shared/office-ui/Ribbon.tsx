import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { BackstageView, defaultBackstageItem } from "./Backstage";
import { cx, useIsomorphicLayoutEffect } from "./internal";
import { Popover } from "./Popover";
import { RibbonItemView } from "./RibbonControls";
import { isFloatingSurface, rovingHandlers, rovingStop, useGroupFit, useRovingSync } from "./ribbon-layout";
import { Chevron, tooltipFor } from "./ribbon-parts";
import type { RibbonBackstageTab, RibbonGroup, RibbonItem, RibbonPanelTab, RibbonTab } from "./ribbon-types";

export interface BackstageState {
  /** The backstage tab that is open. */
  tab: string;
  /** The item whose content is shown, or null for none. */
  item: string | null;
}

export interface RibbonProps {
  tabs: readonly RibbonTab[];
  /** Id of the panel tab whose groups are shown. */
  activeTab: string;
  onTabChange: (id: string) => void;
  /** Tabs only; a tab click then shows the groups as an overlay. */
  collapsed?: boolean;
  /** Enables double-click on a tab and the chevron button. */
  onToggleCollapsed?: () => void;
  /** Content before the tab row. */
  leading?: ReactNode;
  /** Content after the tab row (share, account, agent toggle). */
  trailing?: ReactNode;
  /** Accessible name of the tab row (default "Ribbon"). */
  label?: string;
  /** Controlled backstage; omit to let the ribbon manage it. */
  backstage?: BackstageState | null;
  onBackstageChange?: (state: BackstageState | null) => void;
  className?: string;
}

function isBackstageTab(tab: RibbonTab): tab is RibbonBackstageTab {
  return tab.mode === "backstage";
}

function firstIcon(items: readonly RibbonItem[]): ReactNode {
  for (const item of items) {
    if (item.kind === "stack") {
      const nested = firstIcon(item.rows.flat());
      if (nested) return nested;
    } else if ("icon" in item && item.icon) {
      return item.icon;
    }
  }
  return null;
}

function GroupBody({ group, labelId }: { group: RibbonGroup; labelId: string }) {
  return (
    <>
      <div className="oui-ribbon__group-items">
        {group.items.map((item) => <RibbonItemView key={item.id} item={item} />)}
      </div>
      <div className="oui-ribbon__group-footer">
        <span className="oui-ribbon__group-label" id={labelId}>{group.label}</span>
        {group.launcher && (
          <button
            type="button"
            className="oui-ribbon__launcher"
            aria-label={group.launcher.label}
            aria-keyshortcuts={group.launcher.shortcut}
            title={tooltipFor(group.launcher.label, group.launcher.shortcut)}
            onClick={group.launcher.onClick}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path d="M3 3h6v6M9 9L3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </>
  );
}

function ExpandedGroup({ group }: { group: RibbonGroup }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} data-group-id={group.id} className="oui-ribbon__group" {...rovingHandlers()}>
      <GroupBody group={group} labelId={labelId} />
    </div>
  );
}

/** A group squeezed out by a narrow window: one button that opens the whole group in a popover. */
function CollapsedGroup({ group }: { group: RibbonGroup }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useRovingSync(floatingRef);
  return (
    <div data-group-id={group.id} className="oui-ribbon__group is-collapsed" {...rovingHandlers()}>
      <button
        ref={buttonRef}
        type="button"
        className="oui-ribbon__button oui-ribbon__button--large oui-ribbon__overflow"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={group.label}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="oui-ribbon__icon" aria-hidden="true">{group.icon ?? firstIcon(group.items)}</span>
        <span className="oui-ribbon__label">{group.label}</span>
        <Chevron />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={buttonRef} label={group.label} className="oui-ribbon__group-popover">
        <div ref={floatingRef} role="group" aria-labelledby={labelId} className="oui-ribbon__group oui-ribbon__group--floating" {...rovingHandlers()}>
          <GroupBody group={group} labelId={labelId} />
        </div>
      </Popover>
    </div>
  );
}

function RibbonPanel({ tab, id, labelledBy, overlay }: { tab: RibbonPanelTab; id: string; labelledBy: string; overlay: boolean }) {
  const groupsRef = useRef<HTMLDivElement>(null);
  const expanded = useGroupFit(groupsRef, tab.id, tab.groups.map((group) => group.id));
  useRovingSync(groupsRef);
  return (
    <div role="tabpanel" id={id} aria-labelledby={labelledBy} tabIndex={-1} className={cx("oui-ribbon__panel", overlay && "is-overlay")}>
      <div ref={groupsRef} className="oui-ribbon__groups">
        {tab.groups.map((group, index) =>
          index < expanded ? <ExpandedGroup key={group.id} group={group} /> : <CollapsedGroup key={group.id} group={group} />,
        )}
      </div>
    </div>
  );
}

/**
 * Tabbed command surface. The tab row doubles as the menu bar; the active tab's
 * groups sit below it. Narrow windows collapse groups from the right into
 * overflow buttons, never wrapping. A tab with mode "backstage" opens a
 * full-height file panel instead of groups.
 */
export function Ribbon({
  tabs,
  activeTab,
  onTabChange,
  collapsed = false,
  onToggleCollapsed,
  leading,
  trailing,
  label = "Ribbon",
  backstage,
  onBackstageChange,
  className,
}: RibbonProps) {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusedTab, setFocusedTab] = useState<string | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [focusPanel, setFocusPanel] = useState(false);
  const [ownBackstage, setOwnBackstage] = useState<BackstageState | null>(null);
  const backstageState = backstage !== undefined ? backstage : ownBackstage;

  const panelTabs = tabs.filter((tab): tab is RibbonPanelTab => !isBackstageTab(tab));
  const activePanel = panelTabs.find((tab) => tab.id === activeTab) ?? panelTabs[0];
  const overlayOpen = collapsed && overlay;
  const showPanel = Boolean(activePanel) && (!collapsed || overlay);
  const openBackstageTab = backstageState ? tabs.find((tab): tab is RibbonBackstageTab => isBackstageTab(tab) && tab.id === backstageState.tab) : undefined;
  const rovingTab = focusedTab ?? activePanel?.id ?? tabs[0]?.id;
  const panelId = `${uid}-panel`;
  const tabId = (id: string) => `${uid}-tab-${id}`;

  const setBackstage = (state: BackstageState | null) => {
    if (backstage === undefined) setOwnBackstage(state);
    onBackstageChange?.(state);
  };

  const toggleCollapsed = () => {
    setOverlay(false);
    onToggleCollapsed?.();
  };

  useEffect(() => {
    if (!overlayOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || rootRef.current?.contains(target) || isFloatingSurface(target)) return;
      setOverlay(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [overlayOpen]);

  useIsomorphicLayoutEffect(() => {
    if (!focusPanel) return;
    setFocusPanel(false);
    const firstGroup = rootRef.current?.querySelector<HTMLElement>(".oui-ribbon__groups [data-oui-roving]") ?? null;
    rovingStop(firstGroup)?.focus();
  }, [focusPanel]);

  const activate = (tab: RibbonTab) => {
    if (isBackstageTab(tab)) {
      setBackstage({ tab: tab.id, item: defaultBackstageItem(tab.backstage) });
      return;
    }
    if (collapsed) {
      if (overlay && tab.id === activePanel?.id) {
        setOverlay(false);
        return;
      }
      setOverlay(true);
    }
    if (tab.id !== activeTab) onTabChange(tab.id);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tab: RibbonTab, index: number) => {
    const count = tabs.length;
    let target = -1;
    switch (event.key) {
      case "ArrowRight": target = (index + 1) % count; break;
      case "ArrowLeft": target = (index - 1 + count) % count; break;
      case "Home": target = 0; break;
      case "End": target = count - 1; break;
      case "Enter":
      case " ":
        event.preventDefault();
        activate(tab);
        return;
      case "ArrowDown":
        event.preventDefault();
        if (isBackstageTab(tab)) {
          activate(tab);
          return;
        }
        if (collapsed) setOverlay(true);
        if (tab.id !== activeTab) onTabChange(tab.id);
        setFocusPanel(true);
        return;
      default:
        return;
    }
    event.preventDefault();
    const next = tabs[target];
    setFocusedTab(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const onTablistBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setFocusedTab(null);
  };

  const onRootBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!overlayOpen) return;
    const next = event.relatedTarget as Node | null;
    if (!next || rootRef.current?.contains(next) || isFloatingSurface(next)) return;
    setOverlay(false);
  };

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !overlayOpen || event.defaultPrevented) return;
    event.preventDefault();
    if (activePanel) tabRefs.current.get(activePanel.id)?.focus();
    setOverlay(false);
  };

  return (
    <div
      ref={rootRef}
      className={cx("oui-ribbon", collapsed && "is-collapsed", className)}
      onKeyDown={onRootKeyDown}
      onBlur={onRootBlur}
    >
      <div className="oui-ribbon__bar">
        {leading && <div className="oui-ribbon__leading">{leading}</div>}
        <div role="tablist" aria-label={label} className="oui-ribbon__tabs" onBlur={onTablistBlur}>
          {tabs.map((tab, index) => {
            const backstageTab = isBackstageTab(tab);
            const selected = !backstageTab && tab.id === activePanel?.id;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                id={tabId(tab.id)}
                aria-selected={selected}
                aria-controls={selected && showPanel ? panelId : undefined}
                aria-haspopup={backstageTab ? "dialog" : undefined}
                aria-expanded={backstageTab ? backstageState?.tab === tab.id : undefined}
                tabIndex={tab.id === rovingTab ? 0 : -1}
                className={cx("oui-ribbon__tab", backstageTab && "oui-ribbon__tab--backstage", selected && showPanel && "is-selected")}
                onClick={() => activate(tab)}
                onDoubleClick={() => {
                  if (!backstageTab && onToggleCollapsed) toggleCollapsed();
                }}
                onKeyDown={(event) => onTabKeyDown(event, tab, index)}
                onFocus={() => setFocusedTab(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="oui-ribbon__bar-end">
          {trailing}
          {onToggleCollapsed && (
            <button
              type="button"
              className={cx("oui-ribbon__collapse", collapsed && "is-collapsed")}
              aria-label={collapsed ? "Pin the ribbon" : "Collapse the ribbon"}
              title={collapsed ? "Pin the ribbon" : "Collapse the ribbon"}
              onClick={toggleCollapsed}
            >
              <Chevron />
            </button>
          )}
        </div>
      </div>
      {showPanel && activePanel && <RibbonPanel tab={activePanel} id={panelId} labelledBy={tabId(activePanel.id)} overlay={overlayOpen} />}
      {backstageState && openBackstageTab && (
        <BackstageView
          label={openBackstageTab.label}
          backstage={openBackstageTab.backstage}
          item={backstageState.item}
          onItemChange={(item) => setBackstage({ tab: openBackstageTab.id, item })}
          onClose={() => setBackstage(null)}
          topRef={rootRef}
        />
      )}
    </div>
  );
}
