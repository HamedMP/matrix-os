"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CanonicalChatNavigationPageQuery, CanonicalChatNavigationPageResponse } from "@matrix-os/contracts";
import type { RenameableConversation } from "./ChatTitleRename";

type Group = "pinned" | "needsYou" | "working" | "done";
type LoadPage = (input: CanonicalChatNavigationPageQuery) => Promise<CanonicalChatNavigationPageResponse>;
type PageState = { key: string; rows: RenameableConversation[]; count: number; cursor?: string; loading: boolean; error: boolean };

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
      setState({ key, rows, count, cursor, loading: false, error: false });
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
        return { ...previous, rows: [...previous.rows, ...additions], count: page.totalCount, cursor: page.nextCursor, loading: false };
      });
    }).catch((error: unknown) => {
      if (generation.current !== current) return;
      console.warn("[chat-navigation] More status chats unavailable:", error instanceof Error ? error.name : "UnknownError");
      setState(previous => ({ ...previous, loading: false, error: true }));
    });
  }, [group, key, loadPage, state]);
  return state.key === key ? { ...state, loadMore } : { key, rows: [], count: 0, loading: Boolean(loadPage), error: false, loadMore };
}
