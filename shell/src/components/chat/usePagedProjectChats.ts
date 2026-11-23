import { mergeChatReadState, type ChatNavigationRecord, chatImportSourceVersionUrl } from "@matrix-os/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const MAX_RETAINED_PROJECT_ROWS = 500;
const NO_READ_UPDATES: readonly ChatNavigationRecord[] = [];
export function withChatReadStateUpdates<T extends ChatNavigationRecord>(record: T, updates: readonly ChatNavigationRecord[]): T {
  const update = updates.find(item => item.chat.id === record.chat.id);
  return update ? mergeChatReadState(record, update) : record;
}
export function withConversationReadUpdates(row: RenameableConversation, updates: readonly ChatNavigationRecord[]): RenameableConversation {
  if (!row.canonicalRecord) return row;
  const record = withChatReadStateUpdates(row.canonicalRecord, updates);
  return record === row.canonicalRecord ? row : { ...row, canonicalRecord: record, readState: record.readState };
}
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
export function usePagedProjectChats(project: WebProject, gatewayUrl: string, unreadOnly: boolean, initiallyExpanded = false, loadNavigationPage?: LoadNavigationPage, refreshVersion: number | string = 0, membershipVersion = "", readUpdates: readonly ChatNavigationRecord[] = NO_READ_UPDATES) {
  const initialCursors = useCallback((): PageCursors => ({ id: null, ...(project.slug === project.id ? {} : { slug: null }) }), [project.id, project.slug]);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [fetched, setFetched] = useState<FetchedProjectChat[]>([]);
  const [pageCursors, setPageCursors] = useState<PageCursors>(initialCursors);
  const [nextCursors, setNextCursors] = useState<PageCursors>({});
  const [loading, setLoading] = useState(initiallyExpanded);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const previousVersion = useRef({ refreshVersion, membershipVersion });
  const reloading = useRef(false);
  const retainedCursors = useRef<{ id: Array<string | null>; slug: Array<string | null> }>({ id: [], slug: [] });
  useEffect(() => {
    if (previousVersion.current.refreshVersion === refreshVersion && previousVersion.current.membershipVersion === membershipVersion) return;
    previousVersion.current = { refreshVersion, membershipVersion };
    reloading.current = true;
    setLoading(expanded);
    setError(false);
    setRetryCount(value => value + 1);
  }, [refreshVersion, membershipVersion, expanded]);

  // Each project source is paged independently, and closing or changing the
  // authority aborts both reads.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- the routed owner's computer is only known at runtime.
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    const reload = reloading.current;
    const cursors = reload ? initialCursors() : pageCursors;
    const sources: Array<{ key: "id" | "slug"; value: string; cursor: string | null }> = [];
    if (cursors.id !== undefined) sources.push({ key: "id", value: project.id, cursor: cursors.id });
    if (cursors.slug !== undefined) sources.push({ key: "slug", value: project.slug, cursor: cursors.slug });
    void Promise.all(sources.map(async source => {
      const rows: FetchedProjectChat[] = [];
      const loaded = retainedCursors.current[source.key], windowCursors: Array<string | null> = [];
      let cursor: string | null | undefined = reload ? loaded[0] ?? source.cursor : source.cursor;
      do {
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        windowCursors.push(cursor ?? null);
        const canonical: CanonicalChatNavigationPageResponse | undefined = loadNavigationPage
          ? await loadNavigationPage({ group: "project", projectId: source.value, limit: cursor ? 20 : 5, ...(cursor ? { cursor } : {}) }) : undefined;
        const page: CanonicalChatNavigationPageResponse | z.infer<typeof ProjectChatsResponseSchema> = canonical ?? await loadProjectChats(gatewayUrl, source.value, cursor ?? null, unreadOnly, controller.signal);
        rows.push(...page.items.map((item, index) => ({
          id: item.chat.id, title: item.chat.title, titleVersion: item.chat.titleVersion ?? 0, importSource: item.importSource,
          canonicalRecord: canonical?.items[index],
        })).filter(row => !unreadOnly || !row.canonicalRecord || row.canonicalRecord.readState.unread));
        cursor = page.nextCursor;
      } while (cursor && reload && windowCursors.length < loaded.length);
      return { key: source.key, cursors: windowCursors, nextCursor: cursor, rows };
    })).then(pages => {
      if (controller.signal.aborted) return;
      const rows: FetchedProjectChat[] = pages.flatMap(({ rows }) => rows);
      setFetched(previous => {
        const additions: FetchedProjectChat[] = [];
        for (const row of rows) {
          if (!previous.some(item => item.id === row.id) && !additions.some(item => item.id === row.id)) additions.push(row);
        }
        // Keep a bounded window while the cursor continues through full history.
        if (reload || sources.some(source => source.cursor === null)) {
          const uniqueRows = rows.filter((row, index) => rows.findIndex(item => item.id === row.id) === index);
          if (reload && uniqueRows.length > MAX_RETAINED_PROJECT_ROWS) {
            // Refresh the combined retained window, rather than favoring the last source.
            return previous.flatMap(prior => {
              const refreshed = uniqueRows.find(row => row.id === prior.id);
              return refreshed ? [refreshed] : [];
            });
          }
          return reload ? uniqueRows.slice(-MAX_RETAINED_PROJECT_ROWS)
            : [...uniqueRows, ...previous.filter(row => !uniqueRows.some(item => item.id === row.id))].slice(0, MAX_RETAINED_PROJECT_ROWS);
        }
        return [...previous, ...additions].slice(-MAX_RETAINED_PROJECT_ROWS);
      });
      const next: PageCursors = {};
      for (const { key, nextCursor, cursors } of pages) {
        next[key] = nextCursor ?? undefined;
        // At most 26 pages cover the bounded 500-row window, including its partial edge.
        retainedCursors.current[key] = (reload || cursors[0] === null ? cursors : [...retainedCursors.current[key], ...cursors]).slice(-26);
      }
      reloading.current = false;
      setNextCursors(next);
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[web-projects] chats unavailable", cause instanceof Error ? cause.name : "UnknownError");
      setError(true);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [expanded, gatewayUrl, project.id, project.slug, pageCursors, retryCount, unreadOnly, loadNavigationPage, initialCursors]);

  const toggleExpanded = () => {
    if (expanded) {
      retainedCursors.current = { id: [], slug: [] };
      reloading.current = false;
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
  const visible = useMemo(() => fetched.map(row => row.canonicalRecord
    ? { ...row, canonicalRecord: withChatReadStateUpdates(row.canonicalRecord, readUpdates) } : row)
    .filter(row => !unreadOnly || !row.canonicalRecord || row.canonicalRecord.readState.unread), [fetched, readUpdates, unreadOnly]);
  return { expanded, toggleExpanded, fetched: visible, loading, error, retry, loadMore, capped: false,
    hasMore: Boolean(nextCursors.id || nextCursors.slug) };
}
import type { RenameableConversation } from "./ChatTitleRename";
type Group = "pinned" | "needsYou" | "working" | "done";
type PageState = { key: string; rows: RenameableConversation[]; count: number; cursor?: string; loading: boolean; error: boolean };
const MAX_RETAINED_STATUS_ROWS = 500;
function conversation(item: CanonicalChatNavigationPageResponse["items"][number]): RenameableConversation {
  return {
    id: item.chat.id,
    title: item.chat.title,
    preview: item.chat.title,
    messageCount: item.chat.messageCount,
    updatedAt: Date.parse(item.chat.activityAt ?? item.chat.updatedAt),
    canonicalRecord: item,
    readState: item.readState,
  };
}
/** Each status group owns its cursor and retains visible rows while a page is in flight. */
export function usePagedStatusGroup(group: Group, loadPage?: LoadNavigationPage, scopeKey?: string, version?: number) {
  const key = `${scopeKey ?? ""}\0${group}`;
  const [state, setState] = useState<PageState>({ key: "", rows: [], count: 0, loading: false, error: false });
  const [retryCount, setRetryCount] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!loadPage) return;
    const current = ++generation.current;
    const targetCount = state.key === key ? Math.max(10, state.rows.length) : 10;
    setState(previous => previous.key === key
      ? { ...previous, loading: true, error: false }
      : { key, rows: [], count: 0, loading: true, error: false });
    void (async () => {
      const rows: RenameableConversation[] = [];
      let cursor: string | undefined;
      let count = 0;
      do {
        const page = await loadPage({ group, limit: cursor ? 20 : 10, ...(cursor ? { cursor } : {}) });
        if (generation.current !== current) return;
        for (const item of page.items.map(conversation)) if (!rows.some(row => row.id === item.id)) rows.push(item);
        count = page.totalCount;
        cursor = page.nextCursor;
      } while (cursor && rows.length < targetCount);
      if (generation.current !== current) return;
      setState({ key, rows: rows.slice(-MAX_RETAINED_STATUS_ROWS), count, cursor, loading: false, error: false });
    })().catch((error: unknown) => {
      if (generation.current !== current) return;
      console.warn("[chat-navigation] Status page unavailable:", error instanceof Error ? error.name : "UnknownError");
      setState(previous => ({ ...previous, loading: false, error: true }));
    });
    return () => { generation.current++; };
  }, [group, key, loadPage, version, retryCount]);
  const retry = useCallback(() => {
    if (!loadPage || state.loading) return;
    setRetryCount(value => value + 1);
  }, [loadPage, state.loading]);
  const loadMore = useCallback(() => {
    if (!loadPage || state.key !== key || !state.cursor || state.loading) return;
    const current = generation.current;
    const cursor = state.cursor;
    setState(previous => ({ ...previous, loading: true, error: false }));
    void loadPage({ group, limit: 20, cursor }).then(page => {
      if (generation.current !== current) return;
      setState(previous => {
        const additions: RenameableConversation[] = [];
        for (const row of page.items.map(conversation)) {
          if (!previous.rows.some(item => item.id === row.id) && !additions.some(item => item.id === row.id)) additions.push(row);
        }
        return { ...previous, rows: [...previous.rows, ...additions].slice(-MAX_RETAINED_STATUS_ROWS), count: page.totalCount, cursor: page.nextCursor, loading: false };
      });
    }).catch((error: unknown) => {
      if (generation.current !== current) return;
      console.warn("[chat-navigation] More status chats unavailable:", error instanceof Error ? error.name : "UnknownError");
      setState(previous => ({ ...previous, loading: false, error: true }));
    });
  }, [group, key, loadPage, state]);
  return state.key === key ? { ...state, loadMore, retry } : { key, rows: [], count: 0, loading: Boolean(loadPage), error: false, loadMore, retry };
}
