/** Tab order and colours of the open file, loaded once per path. */
import { useCallback, useEffect, useState } from "react";
import { EMPTY_LOOK, type TabLook, type TabLookStore } from "./sheet-tabs-model";

export function useTabLook(store: TabLookStore, path: string | null): [TabLook, (look: TabLook) => void] {
  const [entry, setEntry] = useState<{ path: string | null; look: TabLook }>({ path, look: EMPTY_LOOK });
  useEffect(() => {
    if (path === null) return undefined;
    let live = true;
    void store.load(path).then((look) => {
      if (live) setEntry((current) => (current.path === null && current.look !== EMPTY_LOOK ? { path, look: current.look } : { path, look }));
    });
    return () => {
      live = false;
    };
  }, [store, path]);
  const look = entry.path === path || entry.path === null ? entry.look : EMPTY_LOOK;
  const change = useCallback(
    (next: TabLook) => {
      setEntry({ path, look: next });
      if (path !== null) void store.save(path, next);
    },
    [store, path],
  );
  return [look, change];
}
