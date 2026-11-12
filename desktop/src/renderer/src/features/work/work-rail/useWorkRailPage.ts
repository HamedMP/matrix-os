import { useCallback, useEffect, useRef, useState } from "react";
import type { CanonicalChatNavigationPageQuery } from "@matrix-os/contracts";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import type { CanonicalChatClient } from "../../../lib/canonical-chat-client";

type State = { key: string; rows: ChatNavigationRecord[]; count: number; cursor?: string; loading: boolean; error: boolean };

/** An independent cursor and retained rows for one rail placement. */
export function useWorkRailPage(client: CanonicalChatClient | null, query: Pick<CanonicalChatNavigationPageQuery, "group" | "projectId">,
  scopeKey: string, version: number, initialSize: number) {
  const key = JSON.stringify([scopeKey, query.group, query.projectId]);
  const generation = useRef(0);
  const [state, setState] = useState<State>({ key: "", rows: [], count: 0, loading: false, error: false });
  useEffect(() => {
    if (!client?.navigationPage) {
      generation.current++;
      setState(previous => previous.rows.length || previous.count || previous.cursor || previous.loading || previous.error
        ? { key: "", rows: [], count: 0, loading: false, error: false } : previous);
      return;
    }
    const current = ++generation.current;
    const targetCount = state.key === key ? Math.max(initialSize, state.rows.length) : initialSize;
    setState(previous => previous.key === key ? { ...previous, loading: true, error: false }
      : { key, rows: [], count: 0, loading: true, error: false });
    void (async () => {
      const rows: ChatNavigationRecord[] = [];
      let cursor: string | undefined;
      let count = 0;
      do {
        const page = await client.navigationPage!({ ...query, limit: cursor ? 20 : initialSize, ...(cursor ? { cursor } : {}) });
        if (generation.current !== current) return;
        rows.push(...page.items.filter(item => !rows.some(row => row.chat.id === item.chat.id)));
        count = page.totalCount;
        cursor = page.nextCursor;
      } while (cursor && rows.length < targetCount);
      if (generation.current !== current) return;
      setState({ key, rows, count, cursor, loading: false, error: false });
    })().catch((cause: unknown) => {
      if (generation.current !== current) return;
      console.warn("[work-rail] Navigation page unavailable:", cause instanceof Error ? cause.name : "UnknownError");
      setState(previous => ({ ...previous, loading: false, error: true }));
    });
    return () => { generation.current++; };
  }, [client, key, query.group, query.projectId, version, initialSize]);
  const loadMore = useCallback(() => {
    if (!client?.navigationPage || state.key !== key || !state.cursor || state.loading) return;
    const current = generation.current;
    setState(previous => ({ ...previous, loading: true, error: false }));
    void client.navigationPage({ ...query, limit: 20, cursor: state.cursor }).then(page => {
      if (generation.current !== current) return;
      setState(previous => ({ ...previous, rows: [...previous.rows, ...page.items.filter(item => !previous.rows.some(row => row.chat.id === item.chat.id))],
        count: page.totalCount, cursor: page.nextCursor, loading: false }));
    }).catch((cause: unknown) => {
      if (generation.current !== current) return;
      console.warn("[work-rail] More chats unavailable:", cause instanceof Error ? cause.name : "UnknownError");
      setState(previous => ({ ...previous, loading: false, error: true }));
    });
  }, [client, key, query.group, query.projectId, state]);
  return state.key === key ? { ...state, loadMore } : { key, rows: [], count: 0, loading: Boolean(client?.navigationPage), error: false, loadMore };
}
