import { useCallback, useState, type KeyboardEvent } from "react";
import { moveFocus } from "./internal";

/** Attribute that marks one row of a roving list. */
export const ROW_ATTRIBUTE = "data-oui-row";

export interface RovingRows {
  /** Key of the row that holds the list's one tab stop. */
  current: string | null;
  /** Call from a row's onFocus. */
  focusRow: (key: string) => void;
  /** Up/Down/Home/End move between rows; put it on the list element. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/**
 * One tab stop for a list of rows: Tab enters at the last focused row (the
 * first one at the start), arrows move between rows.
 */
export function useRovingRows(keys: readonly string[]): RovingRows {
  const [active, setActive] = useState<string | null>(null);
  const current = active !== null && keys.includes(active) ? active : (keys[0] ?? null);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`));
    const from = rows.find((row) => row === document.activeElement || row.parentElement?.contains(document.activeElement)) ?? null;
    if (moveFocus(rows, from, event.key, "vertical") >= 0) event.preventDefault();
  }, []);
  return { current, focusRow: setActive, onKeyDown };
}
