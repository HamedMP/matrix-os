import { useState } from "react";

/**
 * Counts closed→open transitions, for use as a refresh key so data that can
 * change between visits (such as organization memberships) is re-read each
 * time a surface opens. Derived during render; no effect needed.
 */
export function useOpenCount(open: boolean): number {
  const [state, setState] = useState({ open, count: open ? 1 : 0 });
  if (state.open !== open) {
    const next = { open, count: open ? state.count + 1 : state.count };
    setState(next);
    return next.count;
  }
  return state.count;
}
