import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { clamp, cx, useIsomorphicLayoutEffect } from "./internal";

export interface ListItemState {
  index: number;
  selected: boolean;
  active: boolean;
}

export interface ListViewProps<T> {
  /** Accessible name for the listbox. */
  label: string;
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, state: ListItemState) => ReactNode;
  /** Fixed row height in px; required for virtualisation. */
  rowHeight: number;
  /** Viewport height in px. Defaults to the measured height, or 480 when unmeasurable. */
  height?: number;
  /** "single" selection follows focus; "multiple" uses Space, Shift and Ctrl/Cmd. */
  selectionMode?: "single" | "multiple" | "none";
  selectedKeys?: readonly string[];
  defaultSelectedKeys?: readonly string[];
  onSelectionChange?: (keys: string[]) => void;
  activeKey?: string | null;
  onActiveChange?: (key: string | null) => void;
  /** Enter or double click on a row. */
  onActivate?: (item: T, index: number) => void;
  /** Extra rows rendered above and below the viewport (default 6). */
  overscan?: number;
  emptyState?: ReactNode;
  className?: string;
}

const FALLBACK_HEIGHT = 480;

/** Virtualised listbox with keyboard navigation and single or multiple selection. */
export function ListView<T>({
  label,
  items,
  getKey,
  renderItem,
  rowHeight,
  height,
  selectionMode = "single",
  selectedKeys,
  defaultSelectedKeys = [],
  onSelectionChange,
  activeKey,
  onActiveChange,
  onActivate,
  overscan = 6,
  emptyState,
  className,
}: ListViewProps<T>) {
  const baseId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [measured, setMeasured] = useState<number | null>(null);
  const [innerSelected, setInnerSelected] = useState<readonly string[]>(defaultSelectedKeys);
  const [innerActive, setInnerActive] = useState<string | null>(null);
  const anchorRef = useRef<number | null>(null);

  const selected = selectedKeys ?? innerSelected;
  const active = activeKey !== undefined ? activeKey : innerActive;
  const keys = useMemo(() => items.map((item, index) => getKey(item, index)), [items, getKey]);
  const indexByKey = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const activeIndex = active == null ? -1 : indexByKey.get(active) ?? -1;

  const viewportHeight = height ?? measured ?? FALLBACK_HEIGHT;
  const pageSize = Math.max(1, Math.floor(viewportHeight / rowHeight));

  useEffect(() => {
    if (height !== undefined) return undefined;
    const el = viewportRef.current;
    if (!el) return undefined;
    const update = () => {
      if (el.clientHeight > 0) setMeasured(el.clientHeight);
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [height]);

  const setSelection = (next: string[]) => {
    if (selectedKeys === undefined) setInnerSelected(next);
    onSelectionChange?.(next);
  };
  const setActive = (key: string | null) => {
    if (activeKey === undefined) setInnerActive(key);
    onActiveChange?.(key);
  };

  const scrollIntoView = (index: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const top = index * rowHeight;
    let next = el.scrollTop;
    if (top < next) next = top;
    else if (top + rowHeight > next + viewportHeight) next = top + rowHeight - viewportHeight;
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      setScrollTop(next);
    }
  };

  const rangeKeys = (from: number, to: number) => {
    const [start, end] = from <= to ? [from, to] : [to, from];
    return keys.slice(start, end + 1);
  };

  const moveTo = (index: number, extend: boolean) => {
    if (keys.length === 0) return;
    const target = clamp(index, 0, keys.length - 1);
    const key = keys[target];
    setActive(key);
    scrollIntoView(target);
    if (selectionMode === "single") {
      setSelection([key]);
      anchorRef.current = target;
    } else if (selectionMode === "multiple" && extend) {
      const anchor = anchorRef.current ?? (activeIndex >= 0 ? activeIndex : target);
      anchorRef.current = anchor;
      setSelection(rangeKeys(anchor, target));
    }
  };

  const toggle = (index: number) => {
    const key = keys[index];
    anchorRef.current = index;
    if (selectionMode === "single") setSelection([key]);
    else if (selectionMode === "multiple") {
      setSelection(selectedSet.has(key) ? selected.filter((k) => k !== key) : [...selected, key]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (keys.length === 0) return;
    const extend = event.shiftKey && selectionMode === "multiple";
    const modifier = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case "ArrowDown":
        moveTo(activeIndex < 0 ? 0 : activeIndex + 1, extend);
        break;
      case "ArrowUp":
        moveTo(activeIndex < 0 ? 0 : activeIndex - 1, extend);
        break;
      case "Home":
        moveTo(0, extend);
        break;
      case "End":
        moveTo(keys.length - 1, extend);
        break;
      case "PageDown":
        moveTo((activeIndex < 0 ? 0 : activeIndex) + pageSize, extend);
        break;
      case "PageUp":
        moveTo((activeIndex < 0 ? 0 : activeIndex) - pageSize, extend);
        break;
      case " ":
        if (activeIndex < 0) return;
        toggle(activeIndex);
        break;
      case "Enter":
        if (activeIndex < 0) return;
        onActivate?.(items[activeIndex], activeIndex);
        break;
      case "Escape":
        if (selectionMode !== "multiple" || selected.length === 0) return;
        setSelection([]);
        break;
      case "a":
      case "A":
        if (!modifier || selectionMode !== "multiple") return;
        setSelection([...keys]);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const onRowClick = (index: number, event: MouseEvent) => {
    const key = keys[index];
    setActive(key);
    if (selectionMode === "none") return;
    if (selectionMode === "multiple" && event.shiftKey && anchorRef.current !== null) {
      setSelection(rangeKeys(anchorRef.current, index));
      return;
    }
    if (selectionMode === "multiple" && (event.metaKey || event.ctrlKey)) {
      toggle(index);
      return;
    }
    anchorRef.current = index;
    setSelection([key]);
  };

  useIsomorphicLayoutEffect(() => {
    if (activeIndex >= keys.length && keys.length > 0) setActive(keys[keys.length - 1]);
  });

  const total = items.length;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  const optionId = (index: number) => `${baseId}-opt-${index}`;
  const rows: ReactNode[] = [];
  for (let index = start; index < end; index += 1) {
    const item = items[index];
    const key = keys[index];
    const isSelected = selectedSet.has(key);
    const isActive = index === activeIndex;
    rows.push(
      <div
        key={key}
        id={optionId(index)}
        role="option"
        aria-selected={selectionMode === "none" ? undefined : isSelected}
        aria-setsize={total}
        aria-posinset={index + 1}
        data-active={isActive || undefined}
        className={cx("oui-list__row", isSelected && "is-selected", isActive && "is-active")}
        style={{ top: index * rowHeight, height: rowHeight }}
        onClick={(event) => onRowClick(index, event)}
        onDoubleClick={() => onActivate?.(item, index)}
      >
        {renderItem(item, { index, selected: isSelected, active: isActive })}
      </div>,
    );
  }

  return (
    <div
      ref={viewportRef}
      role="listbox"
      aria-label={label}
      aria-multiselectable={selectionMode === "multiple" || undefined}
      aria-activedescendant={activeIndex >= start && activeIndex < end ? optionId(activeIndex) : undefined}
      tabIndex={0}
      className={cx("oui-list", className)}
      style={height !== undefined ? { height } : undefined}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      {total === 0 ? (
        <div role="presentation" className="oui-list__empty">{emptyState}</div>
      ) : (
        <div role="presentation" className="oui-list__canvas" style={{ height: total * rowHeight }}>{rows}</div>
      )}
    </div>
  );
}
