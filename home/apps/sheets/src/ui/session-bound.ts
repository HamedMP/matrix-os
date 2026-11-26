/**
 * A dialog or question opened for one workbook, such as Save as, Save a copy
 * or the unsaved-edits question. It is stamped with the session shown when it
 * was opened and offered only while that session is still the one shown:
 * once another workbook (or none) takes its place it is dropped, so its
 * buttons never act on the new workbook. Each workbook gets its own session
 * object, so the session is the stamp.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionHost } from "../session";
import type { SheetSession } from "../session/session";

interface Entry<T> {
  session: SheetSession | null;
  value: T;
}

export interface SessionBound<T> {
  /** The value, or null when it was bound to a session that is no longer shown. */
  value: T | null;
  /** Binds `next` to the session shown now; null drops it. */
  set(next: T | null): void;
  /** The value when its session is still shown, read at call time (for handlers that run after an await). */
  current(): T | null;
}

export function useSessionBound<T>(host: SessionHost): SessionBound<T> {
  const [entry, setEntry] = useState<Entry<T> | null>(null);
  const held = useRef<Entry<T> | null>(null);

  const set = useCallback(
    (next: T | null) => {
      const bound = next === null ? null : { session: host.session, value: next };
      held.current = bound;
      setEntry(bound);
    },
    [host],
  );

  const current = useCallback((): T | null => {
    const bound = held.current;
    return bound !== null && bound.session === host.session ? bound.value : null;
  }, [host]);

  // Let go of a value whose session was replaced, so it never comes back.
  useEffect(
    () =>
      host.subscribe(() => {
        const bound = held.current;
        if (bound === null || bound.session === host.session) return;
        held.current = null;
        setEntry(null);
      }),
    [host],
  );

  return { value: entry !== null && entry.session === host.session ? entry.value : null, set, current };
}
