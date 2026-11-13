import { useEffect, useRef, useState } from "react";
import { CollaborativeAppDirectoryResponseSchema, type CollaborativeAppDirectoryItem } from "@matrix-os/contracts";
import { subscribeCollaborationDiscoveryChanged } from "./discovery-events.js";

type DirectoryApi = { get(path: string): Promise<unknown> };
const EMPTY: CollaborativeAppDirectoryItem[] = [];
const MAX_PAGES = 20;
const MAX_VISIBLE_ITEMS = 2_000;
const MAX_VISIBLE_PAGES = MAX_PAGES + 1;
type DirectoryPage = { cursor?: string; items: CollaborativeAppDirectoryItem[] };
type DirectoryState = {
  api: DirectoryApi; identity: string; items: CollaborativeAppDirectoryItem[];
  unavailable: boolean; loading: boolean; nextCursor?: string; hasEarlier: boolean;
  pages: DirectoryPage[];
};
type PageRequest = Pick<DirectoryState, "api" | "identity" | "pages" | "hasEarlier"> & {
  cursor?: string; pageCount: number;
};
export type SharedAppDirectoryControls = {
  unavailable: boolean; retry(): void; hasMore?: boolean; loadMore?(): void;
  loading?: boolean; hasEarlier?: boolean; restart?(): void;
};

/** Metadata only: opening an entry still requires current membership at the owner home. */
export function useSharedAppDirectory(api: DirectoryApi | null, identity: string, enabled = true) {
  const [state, setState] = useState<DirectoryState | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [pageRequest, setPageRequest] = useState<PageRequest | null>(null);
  const latest = useRef(state);
  useEffect(() => { latest.current = state; }, [state]);
  useEffect(() => {
    if (!api || !enabled) return;
    let active = true;
    const continuation = pageRequest?.api === api && pageRequest.identity === identity
      ? pageRequest : null;
    setState((previous) => ({ api, identity,
      items: previous?.api === api && previous.identity === identity ? previous.items : [],
      unavailable: false, loading: true, hasEarlier: continuation?.hasEarlier ?? false,
      pages: previous?.api === api && previous.identity === identity ? previous.pages : [],
    }));
    const load = async () => {
      const pages = [...(continuation?.pages ?? [])];
      let items = pages.flatMap((page) => page.items);
      let cursor = continuation?.cursor;
      let hasEarlier = continuation?.hasEarlier ?? false;
      try {
        const cursors = new Set<string>();
        // Initial discovery is bounded. Further pages are a deliberate user action.
        for (let pageIndex = 0; pageIndex < (continuation?.pageCount ?? MAX_PAGES); pageIndex++) {
          const page = CollaborativeAppDirectoryResponseSchema.parse(await api.get(
            `/api/collaboration/shared-apps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ));
          if (!active) return;
          pages.push({ cursor, items: page.items });
          while (pages.length > MAX_VISIBLE_PAGES || pages.reduce((count, entry) => count + entry.items.length, 0) > MAX_VISIBLE_ITEMS) {
            pages.shift();
            hasEarlier = true;
          }
          items = pages.flatMap((entry) => entry.items).filter((entry, index, all) =>
            all.findIndex((other) => other.scopeId === entry.scopeId) === index);
          if (page.nextCursor && (page.nextCursor === cursor || cursors.has(page.nextCursor))) {
            throw new Error("SharedAppDirectoryCursorRepeated");
          }
          cursor = page.nextCursor;
          if (!cursor) break;
          cursors.add(cursor);
        }
        setState({ api, identity, items, pages, unavailable: false, loading: false, nextCursor: cursor, hasEarlier });
      } catch (error: unknown) {
        console.warn("[shared-app-directory] discovery unavailable", error instanceof Error ? error.name : "UnknownError");
        if (active) setState({ api, identity, items, pages, unavailable: true, loading: false, hasEarlier });
      }
    };
    void load();
    return () => { active = false; };
  }, [api, identity, enabled, refresh, attempt, pageRequest]);
  useEffect(() => {
    if (!api || !enabled) return;
    const reload = () => {
      const current = latest.current;
      if (current?.api === api && current.identity === identity) {
        if (current.loading) return;
        setPageRequest({ api, identity, pages: [], hasEarlier: current.hasEarlier,
          cursor: current.pages[0]?.cursor, pageCount: Math.max(current.pages.length, 1) });
      } else setPageRequest(null);
      setRefresh((value) => value + 1);
    };
    const unsubscribe = subscribeCollaborationDiscoveryChanged(reload);
    const timer = setInterval(reload, 30_000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [api, identity, enabled]);
  const current = enabled && state?.api === api && state.identity === identity ? state : null;
  return { items: current?.items ?? EMPTY, unavailable: current?.unavailable ?? false,
    loading: current?.loading ?? false, hasMore: !!current?.nextCursor, hasEarlier: current?.hasEarlier ?? false,
    retry: () => setAttempt((value) => value + 1),
    restart: () => { setPageRequest(null); setRefresh((value) => value + 1); },
    loadMore: () => {
      if (current?.nextCursor && !current.loading) setPageRequest({ api: current.api, identity,
        pages: current.pages, cursor: current.nextCursor, hasEarlier: current.hasEarlier, pageCount: 1 });
    },
  };
}

export function sharedAppDisplayName(appId: string): string {
  return appId.replaceAll(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}
