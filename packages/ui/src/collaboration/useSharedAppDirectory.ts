import { useEffect, useState } from "react";
import { CollaborativeAppDirectoryResponseSchema, type CollaborativeAppDirectoryItem } from "@matrix-os/contracts";
import { subscribeCollaborationDiscoveryChanged } from "./discovery-events.js";

type DirectoryApi = { get(path: string): Promise<unknown> };
const EMPTY: CollaborativeAppDirectoryItem[] = [];
const MAX_PAGES = 20;

/** Metadata only: opening an entry still requires current membership at the owner home. */
export function useSharedAppDirectory(api: DirectoryApi | null, identity: string, enabled = true) {
  const [state, setState] = useState<{
    api: DirectoryApi; identity: string; items: CollaborativeAppDirectoryItem[]; unavailable: boolean;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!api || !enabled) return;
    let active = true;
    const load = async () => {
      try {
        const items: CollaborativeAppDirectoryItem[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
          const page = CollaborativeAppDirectoryResponseSchema.parse(await api.get(
            `/api/collaboration/shared-apps?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ));
          if (!active) return;
          for (const item of page.items) if (!items.some((entry) => entry.scopeId === item.scopeId)) items.push(item);
          if (!page.nextCursor) { setState({ api, identity, items, unavailable: false }); return; }
          if (cursors.has(page.nextCursor)) throw new Error("SharedAppDirectoryCursorRepeated");
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        throw new Error("SharedAppDirectoryLimitExceeded");
      } catch (error: unknown) {
        console.warn("[shared-app-directory] discovery unavailable", error instanceof Error ? error.name : "UnknownError");
        if (active) setState({ api, identity, items: [], unavailable: true });
      }
    };
    void load();
    const reload = () => setRefresh((value) => value + 1);
    const unsubscribe = subscribeCollaborationDiscoveryChanged(reload);
    const timer = setInterval(reload, 30_000);
    return () => { active = false; unsubscribe(); clearInterval(timer); };
  }, [api, identity, enabled, refresh]);
  const current = enabled && state?.api === api && state.identity === identity ? state : null;
  return { items: current?.items ?? EMPTY, unavailable: current?.unavailable ?? false,
    retry: () => setRefresh((value) => value + 1) };
}

export function sharedAppDisplayName(appId: string): string {
  return appId.replaceAll(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}
