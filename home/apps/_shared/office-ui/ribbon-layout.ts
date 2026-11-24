import { useEffect, useRef, useState, type KeyboardEvent, type RefObject, type FocusEvent } from "react";
import { focusableWithin, moveFocus, useIsomorphicLayoutEffect } from "./internal";

/** Assumed width of a group that has never been measured expanded. */
const UNMEASURED_GROUP_WIDTH = 160;
/** Assumed width of a collapsed group's overflow button before it is measured. */
const UNMEASURED_COLLAPSED_WIDTH = 72;
/** Width caches are keyed by tab and group; clear them beyond this many entries. */
const MAX_CACHED_WIDTHS = 256;

/**
 * Number of groups, counted from the left, that can stay expanded when the rest
 * collapse into overflow buttons. Groups collapse from the right.
 */
export function fitGroups(available: number, full: readonly number[], collapsed: readonly number[]): number {
  const n = full.length;
  for (let expanded = n; expanded > 0; expanded -= 1) {
    let total = 0;
    for (let i = 0; i < n; i += 1) total += i < expanded ? full[i] : collapsed[i];
    if (total <= available) return expanded;
  }
  return 0;
}

function remember(cache: Map<string, number>, key: string, value: number): void {
  if (!cache.has(key) && cache.size >= MAX_CACHED_WIDTHS) cache.clear();
  cache.set(key, value);
}

/**
 * Measures the groups row and returns how many groups stay expanded. Every
 * render re-measures before paint, so groups never wrap or squeeze: they switch
 * to overflow buttons instead. Elements must carry data-group-id.
 */
export function useGroupFit(containerRef: RefObject<HTMLElement | null>, tabKey: string, groupIds: readonly string[]): number {
  const [expanded, setExpanded] = useState(groupIds.length);
  const [, setTick] = useState(0);
  const full = useRef(new Map<string, number>());
  const collapsed = useRef(new Map<string, number>());
  const [shownTab, setShownTab] = useState(tabKey);
  const idsKey = groupIds.join("|");

  // A new tab starts fully expanded so every group is measured once.
  if (shownTab !== tabKey) {
    setShownTab(tabKey);
    if (expanded !== groupIds.length) setExpanded(groupIds.length);
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => setTick((tick) => (tick + 1) % 1_000_000));
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, tabKey, idsKey]);

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const available = container.getBoundingClientRect().width;
    for (const el of Array.from(container.querySelectorAll<HTMLElement>(":scope > [data-group-id]"))) {
      const key = `${tabKey}/${el.dataset.groupId}`;
      const width = el.getBoundingClientRect().width;
      if (width <= 0) continue;
      remember(el.classList.contains("is-collapsed") ? collapsed.current : full.current, key, width);
    }
    // Unmeasured layout (hidden, or a test without layout): keep everything expanded.
    const next = available <= 0
      ? groupIds.length
      : fitGroups(
          available,
          groupIds.map((id) => full.current.get(`${tabKey}/${id}`) ?? UNMEASURED_GROUP_WIDTH),
          groupIds.map((id) => collapsed.current.get(`${tabKey}/${id}`) ?? UNMEASURED_COLLAPSED_WIDTH),
        );
    if (next !== expanded) setExpanded(next);
  });

  return Math.min(expanded, groupIds.length);
}

const ROVING_KEYS = ["ArrowLeft", "ArrowRight", "Home", "End"];
const lastFocused = new WeakMap<HTMLElement, HTMLElement>();

function rovingItems(container: HTMLElement): HTMLElement[] {
  return focusableWithin(container).filter((el) => el.closest("[data-oui-roving]") === container && !el.closest("[role='menu']"));
}

const FIELD = "input, select, textarea, [contenteditable='true']";

/**
 * One tab stop per container among its buttons: the last focused button, else
 * the first. Form fields keep their own tab stop, because arrow keys edit them
 * and could never leave them.
 */
export function syncRoving(container: HTMLElement | null): void {
  if (!container) return;
  const items = rovingItems(container);
  const buttons = items.filter((item) => !item.matches(FIELD));
  const remembered = lastFocused.get(container);
  const current = remembered && buttons.includes(remembered) ? remembered : buttons.find((item) => item.tabIndex === 0) ?? buttons[0];
  for (const item of items) item.tabIndex = item.matches(FIELD) || item === current ? 0 : -1;
}

/** The control that currently holds the container's tab stop. */
export function rovingStop(container: HTMLElement | null): HTMLElement | null {
  if (!container) return null;
  const items = rovingItems(container);
  return items.find((item) => item.tabIndex === 0) ?? items[0] ?? null;
}

/** Event handlers for a roving-tabindex container (mark it with data-oui-roving). */
export function rovingHandlers() {
  return {
    "data-oui-roving": "",
    onFocus(event: FocusEvent<HTMLElement>) {
      const container = event.currentTarget;
      const target = event.target as HTMLElement;
      if (target.closest("[data-oui-roving]") !== container || !rovingItems(container).includes(target)) return;
      lastFocused.set(container, target);
      syncRoving(container);
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (!ROVING_KEYS.includes(event.key) || event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target.matches(FIELD)) return;
      if (target.closest("[data-oui-roving]") !== event.currentTarget) return;
      if (moveFocus(rovingItems(event.currentTarget), target, event.key, "horizontal") >= 0) event.preventDefault();
    },
  };
}

/** Keep roving tab stops in sync after every render of the given root. */
export function useRovingSync(rootRef: RefObject<HTMLElement | null>): void {
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (root.hasAttribute("data-oui-roving")) syncRoving(root);
    for (const container of Array.from(root.querySelectorAll<HTMLElement>("[data-oui-roving]"))) syncRoving(container);
  });
}

/** True when focus or a pointer target belongs to a floating surface (menu, popover) the ribbon opened. */
export function isFloatingSurface(node: Node | null): boolean {
  const el = node instanceof Element ? node : node?.parentElement;
  return Boolean(el?.closest(".oui-popover, [data-oui-float]"));
}
