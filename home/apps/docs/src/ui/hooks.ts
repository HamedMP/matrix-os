/** Small React hooks shared by the Docs shell. */

import { useEffect, useRef, useState } from "react";
import type { DocumentSession } from "../session/index";

/**
 * A counter that changes after the active document's content changed: at
 * once when another document is loaded, after `delayMs` of quiet for edits.
 * Views that rebuild derived data (outline, word count, references) key on it.
 */
export function useDocVersion(session: DocumentSession, delayMs: number): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => setVersion((value) => value + 1);
    const stop = session.onChange((change) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (change.kind === "load" || change.kind === "close" || delayMs <= 0) bump();
      else timer = setTimeout(bump, delayMs);
    });
    return () => {
      stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [session, delayMs]);
  return version;
}

/** A ref that always holds the latest value, for callbacks registered once. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
