// Finder-style multi-selection over an ordered list of entry ids (paths).
// Pure so grid, list, keyboard and the selection bar share one behaviour.

export interface SelectionState {
  /** Selected ids in the order they were added. */
  selected: readonly string[];
  /** The id Shift extends from; the last plain or ⌘ click. */
  anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null };

export interface ClickModifiers {
  /** ⌘ on macOS, Ctrl elsewhere. */
  toggle?: boolean;
  range?: boolean;
}

function rangeBetween(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return [to];
  const [start, end] = a <= b ? [a, b] : [b, a];
  return order.slice(start, end + 1);
}

/** A pointer click (or Space/Enter with modifiers) on `id`. */
export function clickSelection(state: SelectionState, id: string, order: readonly string[], modifiers: ClickModifiers = {}): SelectionState {
  if (modifiers.range && state.anchor !== null && order.includes(state.anchor)) {
    const range = rangeBetween(order, state.anchor, id);
    if (modifiers.toggle) {
      const merged = [...state.selected, ...range.filter((item) => !state.selected.includes(item))];
      return { selected: merged, anchor: state.anchor };
    }
    return { selected: range, anchor: state.anchor };
  }
  if (modifiers.toggle) {
    const has = state.selected.includes(id);
    return { selected: has ? state.selected.filter((item) => item !== id) : [...state.selected, id], anchor: id };
  }
  return { selected: [id], anchor: id };
}

export function selectAll(order: readonly string[]): SelectionState {
  return { selected: [...order], anchor: order[0] ?? null };
}

export function clearSelection(): SelectionState {
  return EMPTY_SELECTION;
}

/** Drops ids that no longer exist after a reload, keeping order and the anchor when it survives. */
export function reconcileSelection(state: SelectionState, order: readonly string[]): SelectionState {
  const present = new Set(order);
  const selected = state.selected.filter((id) => present.has(id));
  if (selected.length === state.selected.length && (state.anchor === null || present.has(state.anchor))) return state;
  return { selected, anchor: state.anchor !== null && present.has(state.anchor) ? state.anchor : selected[0] ?? null };
}

/** Header checkbox state for the list view. */
export function headerCheckState(state: SelectionState, order: readonly string[]): boolean | "indeterminate" {
  if (order.length === 0 || state.selected.length === 0) return false;
  const all = order.every((id) => state.selected.includes(id));
  return all ? true : "indeterminate";
}

export function isSelected(state: SelectionState, id: string): boolean {
  return state.selected.includes(id);
}
