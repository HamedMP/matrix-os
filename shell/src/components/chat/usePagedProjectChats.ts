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
export function usePagedProjectChats(project: WebProject, gatewayUrl: string, unreadOnly: boolean, initiallyExpanded = false, loadNavigationPage?: LoadNavigationPage, refreshVersion = 0, membershipVersion = "", readUpdates: readonly ChatNavigationRecord[] = NO_READ_UPDATES) {
  const initialCursors = useCallback((): PageCursors => ({ id: null, ...(project.slug === project.id ? {} : { slug: null }) }), [project.id, project.slug]);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [fetched, setFetched] = useState<FetchedProjectChat[]>([]);
  const [pageCursors, setPageCursors] = useState<PageCursors>(initialCursors);
  const [nextCursors, setNextCursors] = useState<PageCursors>({});
  const [loading, setLoading] = useState(initiallyExpanded);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const previousRefreshVersion = useRef(refreshVersion);
  useEffect(() => {
    if (previousRefreshVersion.current === refreshVersion) return;
    previousRefreshVersion.current = refreshVersion;
    setFetched([]);
    setPageCursors(initialCursors());
    setNextCursors({});
    setLoading(expanded);
    setError(false);
    setRetryCount(value => value + 1);
  }, [refreshVersion, expanded, initialCursors]);

  const previousMembership = useRef(membershipVersion);
  useEffect(() => {
    if (previousMembership.current === membershipVersion) return;
    previousMembership.current = membershipVersion;
    setPageCursors(initialCursors());
    setError(false);
    setLoading(expanded);
    setRetryCount(value => value + 1);
  }, [membershipVersion, expanded, initialCursors]);

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
        return { key: source.key, nextCursor: page.nextCursor, rows: page.items.filter(item => !unreadOnly || item.readState.unread).map(item => ({
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
        // Keep a bounded window while the cursor continues through full history.
        if (sources.some(source => source.cursor === null)) {
          const uniqueRows = rows.filter((row, index) => rows.findIndex(item => item.id === row.id) === index);
          return [...uniqueRows, ...previous.filter(row => !uniqueRows.some(item => item.id === row.id))].slice(0, MAX_RETAINED_PROJECT_ROWS);
        }
        return [...previous, ...additions].slice(-MAX_RETAINED_PROJECT_ROWS);
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
  const visible = useMemo(() => fetched.map(row => row.canonicalRecord
    ? { ...row, canonicalRecord: withChatReadStateUpdates(row.canonicalRecord, readUpdates) } : row)
    .filter(row => !unreadOnly || !row.canonicalRecord || row.canonicalRecord.readState.unread), [fetched, readUpdates, unreadOnly]);
  return { expanded, toggleExpanded, fetched: visible, loading, error, retry, loadMore, capped,
    hasMore: Boolean(nextCursors.id || nextCursors.slug) };
}

import type { RenameableConversation } from "./ChatTitleRename";
type Group = "pinned" | "needsYou" | "working" | "done";
type LoadPage = (input: CanonicalChatNavigationPageQuery) => Promise<CanonicalChatNavigationPageResponse>;
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
export function usePagedStatusGroup(group: Group, loadPage?: LoadPage, scopeKey?: string, version?: number) {
  const key = `${scopeKey ?? ""}\0${group}`;
  const [state, setState] = useState<PageState>({ key: "", rows: [], count: 0, loading: false, error: false });
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
  }, [group, key, loadPage, version]);
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
  return state.key === key ? { ...state, loadMore } : { key, rows: [], count: 0, loading: Boolean(loadPage), error: false, loadMore };
}
