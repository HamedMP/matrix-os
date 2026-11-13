import { useEffect, useState } from "react";
import { CollaborativeAppDirectoryResponseSchema, type CollaborativeAppDirectoryItem } from "@matrix-os/contracts";
import { subscribeCollaborationDiscoveryChanged } from "./discovery-events.js";

type DirectoryApi = { get(path: string): Promise<unknown> };
const EMPTY: CollaborativeAppDirectoryItem[] = [];
const MAX_PAGES = 20;
const MAX_VISIBLE_ITEMS = 2_000;
type DirectoryState = {
  api: DirectoryApi; identity: string; items: CollaborativeAppDirectoryItem[];
  unavailable: boolean; loading: boolean; nextCursor?: string; hasEarlier: boolean;
};
type PageRequest = Pick<DirectoryState, "api" | "identity" | "items" | "hasEarlier"> & { cursor: string; refresh: number };
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
  useEffect(() => {
    if (!api || !enabled) return;
    let active = true;
    const continuation = pageRequest?.api === api && pageRequest.identity === identity && pageRequest.refresh === refresh
      ? pageRequest : null;
    setState((previous) => ({ api, identity,
      items: previous?.api === api && previous.identity === identity ? previous.items : [],
      unavailable: false, loading: true, hasEarlier: continuation?.hasEarlier ?? false,
    }));
    const load = async () => {
      const items = [...(continuation?.items ?? [])];
      let cursor = continuation?.cursor;
      let hasEarlier = continuation?.hasEarlier ?? false;
      try {
        const cursors = new Set<string>();
        // Initial discovery is bounded. Further pages are a deliberate user action.
        for (let pageIndex = 0; pageIndex < (continuation ? 1 : MAX_PAGES); pageIndex++) {
          const page = CollaborativeAppDirectoryResponseSchema.parse(await api.get(
            `/api/collaboration/shared-apps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ));
          if (!active) return;
          for (const item of page.items) if (!items.some((entry) => entry.scopeId === item.scopeId)) items.push(item);
          if (items.length > MAX_VISIBLE_ITEMS) {
            items.splice(0, items.length - MAX_VISIBLE_ITEMS);
            hasEarlier = true;
          }
          if (page.nextCursor && (page.nextCursor === cursor || cursors.has(page.nextCursor))) {
            throw new Error("SharedAppDirectoryCursorRepeated");
          }
          cursor = page.nextCursor;
          if (!cursor) break;
          cursors.add(cursor);
        }
        setState({ api, identity, items, unavailable: false, loading: false, nextCursor: cursor, hasEarlier });
      } catch (error: unknown) {
        console.warn("[shared-app-directory] discovery unavailable", error instanceof Error ? error.name : "UnknownError");
        if (active) setState({ api, identity, items, unavailable: true, loading: false, hasEarlier });
      }
    };
    void load();
    return () => { active = false; };
  }, [api, identity, enabled, refresh, attempt, pageRequest]);
  useEffect(() => {
    if (!api || !enabled) return;
    const reload = () => { setPageRequest(null); setRefresh((value) => value + 1); };
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
        items: current.items, cursor: current.nextCursor, hasEarlier: current.hasEarlier, refresh });
    },
  };
}

export function sharedAppDisplayName(appId: string): string {
  return appId.replaceAll(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}
