import { chatImportSourceVersionUrl } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import type { WebProject } from "./web-projects";

const ProjectChatsResponseSchema = z.object({
  items: z.array(z.object({ chat: z.object({ id: z.string().min(1), title: z.string().min(1),
    titleVersion: z.number().int().nonnegative().optional() }),
    importSource: z.object({ harness: z.enum(["claude", "codex"]) }).optional() })).max(100),
  nextCursor: z.string().regex(/^chatcur_[A-Za-z0-9_-]+$/).max(512).nullable().optional(),
});
export type FetchedProjectChat = { id: string; title: string; titleVersion: number;
  importSource?: { harness: "claude" | "codex" } };
type PageCursors = { id?: string | null; slug?: string | null };
// Older Chats kept per expanded project; paging stops here so a very large project cannot grow memory without bound.
export const MAX_PROJECT_CHAT_ROWS = 1_000;

async function loadProjectChats(gatewayUrl: string, projectId: string, cursor: string | null, unreadOnly: boolean, signal: AbortSignal) {
  const query = new URLSearchParams({ projectId, limit: "100" });
  if (cursor) query.set("cursor", cursor);
  if (unreadOnly) query.set("unread", "true");
  // Without the import-source version the gateway strips provenance, and source filters would drop every row.
  const response = await fetch(chatImportSourceVersionUrl(`${gatewayUrl}/api/chats?${query}`), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error("ProjectChatsUnavailable");
  return ProjectChatsResponseSchema.parse(await response.json());
}

/** Read both immutable-id and legacy-slug chats from the owner-scoped paged API. */
export function usePagedProjectChats(project: WebProject, gatewayUrl: string, unreadOnly: boolean, initiallyExpanded = false) {
  const initialCursors = (): PageCursors => ({ id: null, ...(project.slug === project.id ? {} : { slug: null }) });
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [fetched, setFetched] = useState<FetchedProjectChat[]>([]);
  const [pageCursors, setPageCursors] = useState<PageCursors>(initialCursors);
  const [nextCursors, setNextCursors] = useState<PageCursors>({});
  const [loading, setLoading] = useState(initiallyExpanded);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // Global navigation can stop at 1,000 chats. Each project source is paged
  // independently, and closing or changing the authority aborts both reads.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the routed owner's computer is only known at runtime.
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    const sources: Array<{ key: "id" | "slug"; value: string; cursor: string | null }> = [];
    if (pageCursors.id !== undefined) sources.push({ key: "id", value: project.id, cursor: pageCursors.id });
    if (pageCursors.slug !== undefined) sources.push({ key: "slug", value: project.slug, cursor: pageCursors.slug });
    void Promise.all(sources.map(async source => ({ key: source.key,
      page: await loadProjectChats(gatewayUrl, source.value, source.cursor, unreadOnly, controller.signal),
    }))).then(pages => {
      if (controller.signal.aborted) return;
      const rows = pages.flatMap(({ page }) => page.items.map(item => ({ id: item.chat.id,
        title: item.chat.title, titleVersion: item.chat.titleVersion ?? 0,
        importSource: item.importSource })));
      setFetched(previous => {
        const ids = new Set(previous.map(row => row.id));
        return [...previous, ...rows.filter(row => {
          if (ids.has(row.id)) return false;
          ids.add(row.id);
          return true;
        })].slice(0, MAX_PROJECT_CHAT_ROWS);
      });
      const next: PageCursors = {};
      for (const { key, page } of pages) next[key] = page.nextCursor ?? undefined;
      setNextCursors(next);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[web-projects] chats unavailable", cause instanceof Error ? cause.name : "UnknownError");
      setError(true);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [expanded, gatewayUrl, project.id, project.slug, pageCursors, retryCount, unreadOnly]);

  const toggleExpanded = () => {
    if (expanded) {
      setExpanded(false);
      setFetched([]);
      setPageCursors(initialCursors());
      setNextCursors({});
      setLoading(false);
      setError(false);
    } else {
      setLoading(true);
      setError(false);
      setExpanded(true);
    }
  };
  const retry = () => { setLoading(true); setError(false); setRetryCount(value => value + 1); };
  const loadMore = () => { setLoading(true); setError(false); setPageCursors(nextCursors); };
  const capped = fetched.length >= MAX_PROJECT_CHAT_ROWS;
  return { expanded, toggleExpanded, fetched, loading, error, retry, loadMore, capped,
    hasMore: !capped && Boolean(nextCursors.id || nextCursors.slug) };
}
