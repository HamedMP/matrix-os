import type { CanonicalChatNavigationPageQuery } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../../lib/canonical-chat-client";
import { AppError } from "../../../../../shared/app-error";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import type { Project } from "../../../stores/board";
import { useConnection } from "../../../stores/connection";
import { DEFAULT_RAIL_ORDER, moveRailItem, orderRailItems, parseRailOrderPreference, type RailOrderPreference, type RailSortMode } from "./rail-order";

export function useWorkRailOrder(records: readonly ChatNavigationRecord[], projects: readonly Project[]) {
  const userId = useConnection(state=>state.userId);
  const host = useConnection(state=>state.platformHost);
  const slot = useConnection(state=>state.runtimeSlot);
  const generation = useConnection(state=>state.authGeneration);
  const signedIn = useConnection(state=>state.status === "signed-in");
  const scope = signedIn && userId ? `matrix-chat-rail-order:${JSON.stringify([host,userId,slot])}` : null;
  const [stored,setStored] = useState(()=>({scope,preference:readPreference(scope)}));
  // Reset derived presentation synchronously when its owner/Computer changes,
  // so a prior identity's manual order is never painted in the new scope.
  let current = stored;
  if (stored.scope !== scope) {
    current = {scope,preference:readPreference(scope)};
    setStored(current);
  }
  const preference = current.preference;
  const visibleChatIds = useRef<string[]>([]);
  const orderRows = (rows: readonly ChatNavigationRecord[]) => orderRailItems(rows.map(record => ({
    id: record.chat.id, updatedAt: record.chat.activityAt ?? record.chat.createdAt,
    createdAt: record.chat.createdAt, record,
  })), preference.mode, preference.chatIds).map(item => item.record);
  const registerVisibleChats = (ids: readonly string[]) => { visibleChatIds.current = ids.slice(0, 1000); };
  // Run progress changes updatedAt repeatedly; activityAt advances for new user work.
  const chats = useMemo(()=>orderRailItems(records.map(record=>({id:record.chat.id,updatedAt:record.chat.activityAt ?? record.chat.createdAt,createdAt:record.chat.createdAt,record})),preference.mode,preference.chatIds).map(item=>item.record),[records,preference]);
  const orderedProjects = useMemo(()=>orderRailItems(projects.map(project=>({id:project.id ?? project.slug,updatedAt:project.updatedAt,project})),preference.mode,preference.projectIds).map(item=>item.project),[projects,preference]);
  const scopeKey = JSON.stringify([scope,generation]);
  const save = (next: RailOrderPreference) => {
    const live = useConnection.getState();
    if (live.userId !== userId || live.platformHost !== host || live.runtimeSlot !== slot || live.authGeneration !== generation || (live.status === "signed-in") !== signedIn) return;
    setStored({scope,preference:next});
    if (!scope) return;
    try { window.localStorage.setItem(scope,JSON.stringify(next)); }
    catch (error: unknown) { console.warn("[work] Rail preference save failed:", error instanceof Error ? error.name : "UnknownError"); }
  };
  const setMode = (mode: RailSortMode) => save({...preference,mode,
    chatIds: preference.chatIds.length ? preference.chatIds : chats.map(record=>record.chat.id).slice(0,1000),
    projectIds: preference.projectIds.length ? preference.projectIds : orderedProjects.map(project=>project.id ?? project.slug).slice(0,1000),
  });
  const move = (kind:"chat"|"project", source:string, target:string) => {
    const displayedChatIds = [...new Set([...visibleChatIds.current, ...chats.map(record=>record.chat.id)])].slice(0,1000);
    const chatIds = [...new Set([...displayedChatIds, ...preference.chatIds])].slice(0,1000);
    const projectIds = orderedProjects.map(project=>project.id ?? project.slug).slice(0,1000);
    const ids = kind === "chat" ? chatIds : projectIds;
    if (source === target || !ids.includes(source) || !ids.includes(target)) return;
    // An explicit reorder chooses manual mode from the order currently on screen.
    // The other list may still be loading. Never replace its saved manual IDs
    // with a partial/empty snapshot merely because this list was reordered.
    save({mode:"manual",
      chatIds: preference.mode === "manual" || !displayedChatIds.length ? preference.chatIds : chatIds,
      projectIds: preference.mode === "manual" || !projectIds.length ? preference.projectIds : projectIds,
      [kind === "chat" ? "chatIds" : "projectIds"]:moveRailItem(ids,source,target)});
  };
  return {chats,projects:orderedProjects,mode:preference.mode,setMode,move,scopeKey,orderRows,registerVisibleChats};
}

function readPreference(scope: string | null): RailOrderPreference {
  if (!scope) return DEFAULT_RAIL_ORDER;
  try { return parseRailOrderPreference(window.localStorage.getItem(scope)); }
  catch (error: unknown) {
    console.warn("[work] Rail preference unavailable:", error instanceof Error ? error.name : "UnknownError");
    return DEFAULT_RAIL_ORDER;
  }
}

type WorkRailPageState = { key: string; rows: ChatNavigationRecord[]; count: number; cursor?: string; loading: boolean; error: boolean };

/** An independent cursor and retained rows for one rail placement. */
export function useWorkRailPage(client: CanonicalChatClient | null, query: Pick<CanonicalChatNavigationPageQuery, "group" | "projectId">,
  scopeKey: string, version: number, initialSize: number) {
  const key = JSON.stringify([scopeKey, query.group, query.projectId]);
  const generation = useRef(0);
  const [state, setState] = useState<WorkRailPageState>({ key: "", rows: [], count: 0, loading: false, error: false });
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
      setState(previous => cause instanceof AppError && cause.category === "unauthorized"
        ? { key, rows: [], count: 0, loading: false, error: true }
        : { ...previous, loading: false, error: true });
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
      setState(previous => cause instanceof AppError && cause.category === "unauthorized"
        ? { key, rows: [], count: 0, loading: false, error: true }
        : { ...previous, loading: false, error: true });
    });
  }, [client, key, query.group, query.projectId, state]);
  return client?.navigationPage && state.key === key ? { ...state, loadMore }
    : { key, rows: [], count: 0, loading: Boolean(client?.navigationPage), error: false, loadMore };
}
