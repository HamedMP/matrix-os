import { chatImportSourceVersionUrl } from "@matrix-os/ui";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import type { WebProject } from "./web-projects";
import type { CanonicalChatNavigationItem, CanonicalChatNavigationPageQuery, CanonicalChatNavigationPageResponse } from "@matrix-os/contracts";

const ProjectChatsResponseSchema = z.object({
  items: z.array(z.object({ chat: z.object({ id: z.string().min(1), title: z.string().min(1),
    titleVersion: z.number().int().nonnegative().optional() }),
    importSource: z.object({ harness: z.enum(["claude", "codex"]) }).optional() })).max(100),
  nextCursor: z.string().regex(/^chatcur_[A-Za-z0-9_-]+$/).max(512).nullable().optional(),
});
export type FetchedProjectChat = { id: string; title: string; titleVersion: number;
  importSource?: { harness: "claude" | "codex" }; canonicalRecord?: CanonicalChatNavigationItem };
type LoadNavigationPage = (input: CanonicalChatNavigationPageQuery) => Promise<CanonicalChatNavigationPageResponse>;
type PageCursors = { id?: string | null; slug?: string | null };
async function loadProjectChats(gatewayUrl: string, projectId: string, cursor: string | null, unreadOnly: boolean, signal: AbortSignal) {
  const query = new URLSearchParams({ projectId, limit: cursor ? "20" : "5" });
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
export function usePagedProjectChats(project: WebProject, gatewayUrl: string, unreadOnly: boolean, initiallyExpanded = false, loadNavigationPage?: LoadNavigationPage) {
  const initialCursors = (): PageCursors => ({ id: null, ...(project.slug === project.id ? {} : { slug: null }) });
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [fetched, setFetched] = useState<FetchedProjectChat[]>([]);
  const [pageCursors, setPageCursors] = useState<PageCursors>(initialCursors);
  const [nextCursors, setNextCursors] = useState<PageCursors>({});
  const [loading, setLoading] = useState(initiallyExpanded);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // Each project source is paged independently, and closing or changing the
  // authority aborts both reads.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the routed owner's computer is only known at runtime.
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    const sources: Array<{ key: "id" | "slug"; value: string; cursor: string | null }> = [];
    if (pageCursors.id !== undefined) sources.push({ key: "id", value: project.id, cursor: pageCursors.id });
    if (pageCursors.slug !== undefined) sources.push({ key: "slug", value: project.slug, cursor: pageCursors.slug });
    void Promise.all(sources.map(async source => {
      if (loadNavigationPage) {
        const page = await loadNavigationPage({ group: "project", projectId: source.value, limit: source.cursor ? 20 : 5, ...(source.cursor ? { cursor: source.cursor } : {}) });
        return { key: source.key, nextCursor: page.nextCursor, rows: page.items.filter(item => !unreadOnly || item.readState.markedUnread || item.readState.readThroughSeq < item.chat.messageCount).map(item => ({
          id: item.chat.id, title: item.chat.title, titleVersion: item.chat.titleVersion ?? 0,
          importSource: item.importSource, canonicalRecord: item,
        })) satisfies FetchedProjectChat[] };
      }
      const page = await loadProjectChats(gatewayUrl, source.value, source.cursor, unreadOnly, controller.signal);
      return { key: source.key, nextCursor: page.nextCursor, rows: page.items.map(item => ({ id: item.chat.id,
        title: item.chat.title, titleVersion: item.chat.titleVersion ?? 0, importSource: item.importSource })) satisfies FetchedProjectChat[] };
    })).then(pages => {
      if (controller.signal.aborted) return;
      const rows: FetchedProjectChat[] = pages.flatMap(({ rows }) => rows);
      setFetched(previous => {
        const additions: FetchedProjectChat[] = [];
        for (const row of rows) {
          if (!previous.some(item => item.id === row.id) && !additions.some(item => item.id === row.id)) additions.push(row);
        }
        return [...previous, ...additions];
      });
      const next: PageCursors = {};
      for (const { key, nextCursor } of pages) next[key] = nextCursor ?? undefined;
      setNextCursors(next);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[web-projects] chats unavailable", cause instanceof Error ? cause.name : "UnknownError");
      setError(true);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [expanded, gatewayUrl, project.id, project.slug, pageCursors, retryCount, unreadOnly, loadNavigationPage]);

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
  const capped = false;
  return { expanded, toggleExpanded, fetched, loading, error, retry, loadMore, capped,
    hasMore: Boolean(nextCursors.id || nextCursors.slug) };
}
