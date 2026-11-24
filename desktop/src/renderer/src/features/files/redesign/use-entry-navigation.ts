import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { EntryHandlers } from "./FileCard";
import { clearSelection, clickSelection, EMPTY_SELECTION, reconcileSelection, selectAll, type SelectionState } from "./selection-model";

const TYPEAHEAD_RESET_MS = 700;

/** Columns in a CSS grid, read from its computed template so arrow keys move by row. */
export function gridColumnCount(element: HTMLElement | null): number {
  if (!element) return 1;
  const template = getComputedStyle(element).gridTemplateColumns;
  const count = template.split(" ").filter((part) => part.trim().length > 0 && part !== "none").length;
  return Math.max(1, count);
}

/** Index of the first name starting with `prefix`, searching after `from` and wrapping. */
export function typeaheadMatch(names: readonly string[], prefix: string, from: number): number {
  const needle = prefix.toLocaleLowerCase();
  if (!needle) return -1;
  for (let step = 1; step <= names.length; step += 1) {
    const index = (from + step) % names.length;
    if (names[index]!.toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/**
 * Selection, focus and keyboard for one listing. Click selects, ⌘-click
 * toggles, Shift-click extends, ⌘A selects all, Esc clears, arrows move focus
 * (by row in the grid), Enter or double-click opens, Space toggles the
 * focused entry, and typing jumps to a matching name.
 */
export function useEntryNavigation({
  order,
  names,
  columns,
  onOpen,
}: {
  order: readonly string[];
  names: readonly string[];
  /** Returns how many entries sit in one visual row (1 for the list). */
  columns: () => number;
  onOpen: (path: string) => void;
}) {
  const [storedSelection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);
  const [storedFocus, setFocusIndex] = useState(0);
  const refs = useRef<Array<HTMLElement | null>>([]);
  const typeahead = useRef({ text: "", at: 0 });
  // Entries can disappear on reload; selection and focus follow the current order.
  const selection = useMemo(() => reconcileSelection(storedSelection, order), [order, storedSelection]);
  const focusIndex = Math.min(storedFocus, Math.max(0, order.length - 1));

  const focus = useCallback((index: number) => {
    if (order.length === 0) return;
    const clamped = Math.max(0, Math.min(index, order.length - 1));
    setFocusIndex(clamped);
    refs.current[clamped]?.focus();
  }, [order.length]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>, index: number) => {
    const path = order[index]!;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(selectAll(order));
      return;
    }
    const step = columns();
    const move = (to: number) => {
      event.preventDefault();
      const target = Math.max(0, Math.min(to, order.length - 1));
      focus(target);
      if (event.shiftKey) setSelection(clickSelection(selection, order[target]!, order, { range: true }));
      else if (!mod) setSelection(clickSelection(selection, order[target]!, order));
    };
    switch (event.key) {
      case "Enter":
        event.preventDefault();
        onOpen(path);
        return;
      case " ":
        event.preventDefault();
        setSelection(clickSelection(selection, path, order, { toggle: true }));
        return;
      case "Escape":
        if (selection.selected.length === 0) return;
        event.preventDefault();
        setSelection(clearSelection());
        return;
      case "ArrowDown": move(index + step); return;
      case "ArrowUp": move(index - step); return;
      case "ArrowRight": if (step > 1) move(index + 1); return;
      case "ArrowLeft": if (step > 1) move(index - 1); return;
      case "Home": move(0); return;
      case "End": move(order.length - 1); return;
    }
    if (event.key.length === 1 && !mod && !event.altKey && /\S/.test(event.key)) {
      const now = Date.now();
      const text = now - typeahead.current.at > TYPEAHEAD_RESET_MS ? event.key : typeahead.current.text + event.key;
      typeahead.current = { text, at: now };
      const match = typeaheadMatch(names, text, text.length === 1 ? index : index - 1);
      if (match >= 0) {
        event.preventDefault();
        focus(match);
        setSelection(clickSelection(selection, order[match]!, order));
      }
    }
  }, [columns, focus, names, onOpen, order, selection, setSelection]);

  const handlersFor = useCallback((index: number): EntryHandlers => ({
    onClick: (event: MouseEvent<HTMLElement>) => {
      setFocusIndex(index);
      setSelection(clickSelection(selection, order[index]!, order, { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey }));
    },
    onDoubleClick: () => onOpen(order[index]!),
    onKeyDown: (event) => onKeyDown(event, index),
    onFocus: () => setFocusIndex(index),
  }), [onKeyDown, onOpen, order, selection, setSelection]);

  const toggle = useCallback((index: number) => {
    setSelection(clickSelection(selection, order[index]!, order, { toggle: true }));
  }, [order, selection, setSelection]);

  return { selection, setSelection, focusIndex, refs, handlersFor, toggle, focus };
}
