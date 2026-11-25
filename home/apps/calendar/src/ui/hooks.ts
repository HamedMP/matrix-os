import { useEffect, useState, useSyncExternalStore } from "react";
import type { CalendarState, CalendarStore } from "../model";

/** The store's current state, re-rendering on every change. */
export function useCalendarState(store: CalendarStore): CalendarState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The current time, refreshed every `intervalMs` (for the current-time line). */
export function useNow(now: () => number, intervalMs = 60_000): number {
  const [value, setValue] = useState(now);
  useEffect(() => {
    const timer = setInterval(() => setValue(now()), intervalMs);
    return () => clearInterval(timer);
  }, [now, intervalMs]);
  return value;
}
