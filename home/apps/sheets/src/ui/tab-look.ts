/**
 * Tab order and colours of the open workbook, stored per path.
 *
 * The look is read once, when the workbook first has a path. After that the
 * look on screen is the workbook's own: when the workbook gets a path (its
 * first save) or a new one (a copy), that look is stored under it rather
 * than read from there, so choices made before or while saving are kept.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_LOOK, type TabLook, type TabLookStore } from "./sheet-tabs-model";

interface Entry {
  /** The path the look is stored under, or null before the workbook has one. */
  path: string | null;
  look: TabLook;
  /** True once the look was read or chosen: it is then this workbook's, whatever path it moves to. */
  known: boolean;
}

export function useTabLook(store: TabLookStore, path: string | null): [TabLook, (look: TabLook) => void] {
  const [entry, setEntry] = useState<Entry>({ path, look: EMPTY_LOOK, known: false });
  // The latest entry, for the load callback and the path effect, which outlive the render that made them.
  const latest = useRef(entry);
  const update = useCallback((next: Entry) => {
    latest.current = next;
    setEntry(next);
  }, []);

  useEffect(() => {
    if (path === null) return undefined;
    const current = latest.current;
    if (current.known) {
      if (current.path !== path) {
        update({ ...current, path });
        void store.save(path, current.look);
      }
      return undefined;
    }
    let live = true;
    void store.load(path).then((look) => {
      // A look chosen while the stored one was read wins.
      if (live && !latest.current.known) update({ path, look, known: true });
    });
    return () => {
      live = false;
    };
  }, [store, path, update]);

  const change = useCallback(
    (next: TabLook) => {
      update({ path, look: next, known: true });
      if (path !== null) void store.save(path, next);
    },
    [store, path, update],
  );
  return [entry.look, change];
}
