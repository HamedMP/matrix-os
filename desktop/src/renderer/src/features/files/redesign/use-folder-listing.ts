import { useCallback, useEffect, useRef, useState } from "react";
import { toUserMessage } from "../../../lib/errors";
import { useConnection } from "../../../stores/connection";
import { parseBrowserEntries, type BrowserEntry } from "../browser-entries";

export type ListingStatus = "loading" | "ready" | "error";

export interface FolderListing {
  entries: BrowserEntry[];
  status: ListingStatus;
  error: string | null;
  reload: () => void;
}

const NO_ENTRIES: BrowserEntry[] = [];

/**
 * Loads one folder from `/api/files/list`. A listing belongs to the computer
 * and session it was loaded under: after a runtime or auth switch the old
 * entries are never rendered, and late responses for a superseded path or
 * scope are dropped.
 */
export function useFolderListing(path: string, enabled = true): FolderListing {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const scope = `${runtimeSlot}|${authGeneration}|${path}`;
  const [loaded, setLoaded] = useState<{ scope: string; entries: BrowserEntry[]; status: ListingStatus; error: string | null }>({ scope: "", entries: NO_ENTRIES, status: "loading", error: null });
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (!api || !enabled) return;
    const current = ++generation.current;
    setLoaded((previous) => ({ scope, entries: previous.scope === scope ? previous.entries : NO_ENTRIES, status: previous.scope === scope && previous.status === "ready" ? "ready" : "loading", error: null }));
    try {
      const response = await api.get<{ entries: unknown }>(`/api/files/list?path=${encodeURIComponent(path)}`);
      if (current !== generation.current) return;
      setLoaded({ scope, entries: parseBrowserEntries(response.entries), status: "ready", error: null });
    } catch (error: unknown) {
      if (current !== generation.current) return;
      setLoaded({ scope, entries: NO_ENTRIES, status: "error", error: toUserMessage(error) });
    }
  }, [api, enabled, path, scope]);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const reload = useCallback(() => void load(), [load]);
  const fresh = loaded.scope === scope;
  return {
    entries: fresh ? loaded.entries : NO_ENTRIES,
    status: fresh ? loaded.status : "loading",
    error: fresh ? loaded.error : null,
    reload,
  };
}
