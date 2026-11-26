/**
 * A dialog or question opened for one document, such as Save as, the
 * unsaved-changes question or the file picker of Compare. It is stamped with
 * the `documentKey` active when it was opened and shown only while that
 * document is still the active one: once another document (or none) takes
 * its place it is dropped, so its buttons never act on the new document.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { DocumentSession } from "../session/index";
import { useLatest } from "./hooks";

type BindingSession = Pick<DocumentSession, "getState" | "subscribe" | "onChange">;

interface Entry<T> {
  documentKey: number;
  value: T;
}

const NO_SESSION_KEY = -1;
const noSubscribe = () => () => undefined;

/**
 * `[value, set]`: `set(value)` binds it to the document active now and
 * `set(null)` drops it. `value` is null whenever the active document is not
 * the one it was bound to. `onDropped` runs once for a value dropped because
 * another document became active (for example to settle a pending promise).
 */
export function useDocumentBound<T>(session: BindingSession | null, onDropped?: (value: T) => void): [T | null, (next: T | null) => void] {
  const [entry, setEntry] = useState<Entry<T> | null>(null);
  const held = useRef<Entry<T> | null>(null);
  const dropped = useLatest(onDropped);
  const activeKey = useSyncExternalStore(session?.subscribe ?? noSubscribe, () => session?.getState().documentKey ?? NO_SESSION_KEY);

  const set = useCallback(
    (next: T | null) => {
      const bound = next === null || session === null ? null : { documentKey: session.getState().documentKey, value: next };
      held.current = bound;
      setEntry(bound);
    },
    [session],
  );

  useEffect(() => {
    if (session === null) return undefined;
    return session.onChange((change) => {
      if (change.kind !== "load" && change.kind !== "close") return;
      const current = held.current;
      if (current === null || current.documentKey === session.getState().documentKey) return;
      held.current = null;
      setEntry(null);
      dropped.current?.(current.value);
    });
  }, [session, dropped]);

  return [entry !== null && entry.documentKey === activeKey ? entry.value : null, set];
}
