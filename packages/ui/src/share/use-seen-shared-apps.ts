import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";
import type { HandoffFileApi } from "./use-collaborative-handoff";

/**
 * Which org-shared apps the member has opened, so newly shared apps get a dot.
 * Stored as an owner file (`~/system/share/seen-shared-apps.json`) so it follows
 * the member across devices. Bounded; the oldest entries drop first.
 */
export const SEEN_SHARED_APPS_PATH = "system/share/seen-shared-apps.json";
export const SEEN_SHARED_APPS_MAX = 500;
const SeenSchema = z.strictObject({ version: z.literal(1), seen: z.array(z.string().min(1).max(128)).max(SEEN_SHARED_APPS_MAX) });
const blobPath = `/api/files/blob?path=${encodeURIComponent(SEEN_SHARED_APPS_PATH)}`;
// The list is rewritten on every open; the blob route refuses overwrites without force.
const blobWritePath = `${blobPath}&force=true`;

function notFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { category?: unknown; status?: unknown; httpStatus?: unknown };
  return value.category === "notFound" || value.status === 404 || value.httpStatus === 404;
}

/** Best-effort write; a failure only means the dot may show again. Never throws. */
function save(api: HandoffFileApi, seen: string[]) {
  try {
    void Promise.resolve(api.put(blobWritePath, { version: 1, seen })).catch((error: unknown) => {
      console.warn("[launcher] seen shared apps not saved", error instanceof Error ? error.name : "UnknownError");
    });
  } catch (error: unknown) {
    console.warn("[launcher] seen shared apps not saved", error instanceof Error ? error.name : "UnknownError");
  }
}

export function addSeen(seen: readonly string[], scopeId: string): string[] {
  return [...seen.filter((id) => id !== scopeId), scopeId].slice(-SEEN_SHARED_APPS_MAX);
}

/**
 * `ready` must be true only once the shared-app directory has loaded: the
 * first-ever read baselines every app the member already has as seen, so a
 * rollout does not mark the whole launcher new.
 */
export function useSeenSharedApps({ api, scopeIds, ready }: { api: HandoffFileApi | null; scopeIds: readonly string[]; ready: boolean }) {
  const [seen, setSeen] = useState<string[] | null>(null);
  const loading = useRef(false);
  /** Apps opened before the saved list loaded; merged in (and saved) once it settles. */
  const openedWhileLoading = useRef<string[]>([]);
  // A stable key: callers may pass a fresh array each render.
  const idsKey = scopeIds.join("|");
  useEffect(() => {
    if (!api || !ready || seen !== null || loading.current) return;
    const ids = idsKey ? idsKey.split("|") : [];
    // Settles the loaded list, folding in apps opened meanwhile; saves when that changed it.
    const settle = (base: string[], alreadySaving: boolean) => {
      const opened = openedWhileLoading.current;
      openedWhileLoading.current = [];
      const next = opened.reduce(addSeen, base);
      setSeen(next);
      if (alreadySaving || opened.some((id) => !base.includes(id))) save(api, next);
    };
    // One bounded read (the api applies its own timeout). A re-run discards the
    // older result and starts again, so the state can never stay unloaded.
    loading.current = true;
    let current = true;
    void (async () => {
      try {
        const parsed = SeenSchema.safeParse(await api.get(blobPath));
        if (!current) return;
        settle(parsed.success ? parsed.data.seen : ids, false);
      } catch (error: unknown) {
        if (!current) return;
        if (!notFound(error)) {
          console.warn("[launcher] seen shared apps unavailable", error instanceof Error ? error.name : "UnknownError");
          settle(ids, false);
          return;
        }
        settle(ids.slice(-SEEN_SHARED_APPS_MAX), true);
      } finally { if (current) loading.current = false; }
    })();
    return () => { current = false; loading.current = false; };
  }, [api, ready, idsKey, seen]);
  return {
    isNew: (scopeId: string) => seen !== null && !seen.includes(scopeId),
    markSeen(scopeId: string) {
      if (!api) return;
      if (seen === null) {
        openedWhileLoading.current = addSeen(openedWhileLoading.current, scopeId);
        return;
      }
      if (seen.includes(scopeId)) return;
      const next = addSeen(seen, scopeId);
      setSeen(next);
      save(api, next);
    },
  };
}
