import { forwardRef, useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
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

/**
 * A group squeezed out by a narrow window: one button that opens the whole
 * group in a popover. The popover closes once a command ran (a button, a menu
 * entry, a colour, a style), so it never stays over what the command opened;
 * it stays for a list being changed and for a button that opens a menu.
 */
function CollapsedGroup({ group }: { group: RibbonGroup }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useRovingSync(floatingRef);
  // Clicks in menus and palettes the group opened bubble to here through React, wherever they are drawn.
  const closeAfterCommand = (event: ReactMouseEvent<HTMLElement>) => {
    const command = (event.target as Element).closest("button");
    if (command !== null && !command.hasAttribute("aria-haspopup")) setOpen(false);
  };
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
        <div ref={floatingRef} role="group" aria-labelledby={labelId} className="oui-ribbon__group oui-ribbon__group--floating" {...rovingHandlers()} onClick={closeAfterCommand}>
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

interface RibbonTabButtonProps {
  tab: RibbonTab;
  id: string;
  /** The tab's groups are on screen. */
  shown: boolean;
  selected: boolean;
  panelId: string;
  /** Backstage tabs only: the backstage is open. */
  expanded: boolean;
  /** Holds the tab row's one tab stop. */
  roving: boolean;
  onActivate: () => void;
  /** Panel tabs only: collapses or pins the ribbon. */
  onDoubleClick?: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus: () => void;
}

const RibbonTabButton = forwardRef<HTMLButtonElement, RibbonTabButtonProps>(function RibbonTabButton(
  { tab, id, shown, selected, panelId, expanded, roving, onActivate, onDoubleClick, onKeyDown, onFocus },
  ref,
) {
  const backstage = isBackstageTab(tab);
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      id={id}
      aria-selected={selected}
      aria-controls={shown ? panelId : undefined}
      aria-haspopup={backstage ? "dialog" : undefined}
      aria-expanded={backstage ? expanded : undefined}
      tabIndex={roving ? 0 : -1}
      className={cx("oui-ribbon__tab", backstage && "oui-ribbon__tab--backstage", shown && "is-selected")}
      onClick={onActivate}
      onDoubleClick={backstage ? undefined : onDoubleClick}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {tab.label}
    </button>
  );
});

function CollapseButton({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const name = collapsed ? "Pin the ribbon" : "Collapse the ribbon";
  return (
    <button type="button" className={cx("oui-ribbon__collapse", collapsed && "is-collapsed")} aria-label={name} title={name} onClick={onClick}>
      <Chevron />
    </button>
  );
}

/** The tab an arrow, Home or End key moves to from `index`, or -1 for any other key. */
function tabKeyTarget(key: string, index: number, count: number): number {
  switch (key) {
    case "ArrowRight": return (index + 1) % count;
    case "ArrowLeft": return (index - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return -1;
  }
}

/** True when a press or focus target lies outside the ribbon and the floating surfaces it opened. */
function isOutsideRibbon(root: HTMLElement | null, target: Node | null): boolean {
  return target !== null && !root?.contains(target) && !isFloatingSurface(target);
}

/**
 * Closes the overlay panel of a collapsed ribbon when a press or the focus
 * leaves the ribbon, and on Escape in the ribbon itself (`focusTab` then
 * returns the focus to the tab). Returns the root's blur and key handlers.
 */
function useOverlayDismiss(rootRef: RefObject<HTMLDivElement | null>, open: boolean, setOpen: (open: boolean) => void, focusTab: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (isOutsideRibbon(rootRef.current, event.target as Node | null)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, rootRef, setOpen]);
  return {
    onBlur(event: FocusEvent<HTMLDivElement>) {
      if (open && isOutsideRibbon(rootRef.current, event.relatedTarget as Node | null)) setOpen(false);
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.key !== "Escape" || !open || event.defaultPrevented) return;
      // Escape in a popover, menu or dialog the ribbon opened reaches here through
      // React before that panel's own handler: leave it to close just that panel.
      if (!rootRef.current?.contains(event.target as Node)) return;
      event.preventDefault();
      focusTab();
      setOpen(false);
    },
  };
}

/** The open backstage: the caller's when it controls it, else the ribbon's own. */
function useBackstageState(controlled: BackstageState | null | undefined, onChange: ((state: BackstageState | null) => void) | undefined) {
  const [own, setOwn] = useState<BackstageState | null>(null);
  const set = (state: BackstageState | null) => {
    if (controlled === undefined) setOwn(state);
    onChange?.(state);
  };
  return [controlled !== undefined ? controlled : own, set] as const;
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
  const [backstageState, setBackstage] = useBackstageState(backstage, onBackstageChange);

  const panelTabs = tabs.filter((tab): tab is RibbonPanelTab => !isBackstageTab(tab));
  const activePanel = panelTabs.find((tab) => tab.id === activeTab) ?? panelTabs[0];
  const overlayOpen = collapsed && overlay;
  const showPanel = Boolean(activePanel) && (!collapsed || overlay);
  const openBackstageTab = backstageState ? tabs.find((tab): tab is RibbonBackstageTab => isBackstageTab(tab) && tab.id === backstageState.tab) : undefined;
  const rovingTab = focusedTab ?? activePanel?.id ?? tabs[0]?.id;
  const panelId = `${uid}-panel`;
  const tabId = (id: string) => `${uid}-tab-${id}`;

  const toggleCollapsed = () => {
    setOverlay(false);
    onToggleCollapsed?.();
  };

  const dismiss = useOverlayDismiss(rootRef, overlayOpen, setOverlay, () => {
    if (activePanel) tabRefs.current.get(activePanel.id)?.focus();
  });

  useIsomorphicLayoutEffect(() => {
    if (!focusPanel) return;
    setFocusPanel(false);
    const firstGroup = rootRef.current?.querySelector<HTMLElement>(".oui-ribbon__groups [data-oui-roving]") ?? null;
    rovingStop(firstGroup)?.focus();
  }, [focusPanel]);

  const activate = (tab: RibbonTab) => {
    if (isBackstageTab(tab)) {
      // The tab that opened the backstage closes it again.
      setBackstage(backstageState?.tab === tab.id ? null : { tab: tab.id, item: defaultBackstageItem(tab.backstage) });
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
    const target = tabKeyTarget(event.key, index, tabs.length);
    if (target >= 0) {
      event.preventDefault();
      const next = tabs[target];
      setFocusedTab(next.id);
      tabRefs.current.get(next.id)?.focus();
      return;
    }
    const opens = event.key === "Enter" || event.key === " ";
    if (!opens && event.key !== "ArrowDown") return;
    event.preventDefault();
    if (opens || isBackstageTab(tab)) {
      // Enter and Space toggle the backstage; ArrowDown only opens it.
      if (!opens && backstageState?.tab === tab.id) return;
      activate(tab);
      return;
    }
    // Arrow down shows the tab's groups and moves into them.
    if (collapsed) setOverlay(true);
    if (tab.id !== activeTab) onTabChange(tab.id);
    setFocusPanel(true);
  };

  const onTablistBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setFocusedTab(null);
  };

  return (
    <div
      ref={rootRef}
      className={cx("oui-ribbon", collapsed && "is-collapsed", className)}
      onKeyDown={dismiss.onKeyDown}
      onBlur={dismiss.onBlur}
    >
      <div className="oui-ribbon__bar">
        {leading && <div className="oui-ribbon__leading">{leading}</div>}
        <div role="tablist" aria-label={label} className="oui-ribbon__tabs" onBlur={onTablistBlur}>
          {tabs.map((tab, index) => {
            const selected = !isBackstageTab(tab) && tab.id === activePanel?.id;
            return (
              <RibbonTabButton
                key={tab.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                tab={tab}
                id={tabId(tab.id)}
                shown={selected && showPanel}
                selected={selected}
                panelId={panelId}
                expanded={backstageState?.tab === tab.id}
                roving={tab.id === rovingTab}
                onActivate={() => activate(tab)}
                onDoubleClick={onToggleCollapsed ? toggleCollapsed : undefined}
                onKeyDown={(event) => onTabKeyDown(event, tab, index)}
                onFocus={() => setFocusedTab(tab.id)}
              />
            );
          })}
        </div>
        <div className="oui-ribbon__bar-end">
          {trailing}
          {onToggleCollapsed && <CollapseButton collapsed={collapsed} onClick={toggleCollapsed} />}
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
