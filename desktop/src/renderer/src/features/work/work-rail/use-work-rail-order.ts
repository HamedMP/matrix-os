import type { CanonicalChatNavigationPageQuery } from "@matrix-os/contracts";
import type { CanonicalChatClient } from "../../../lib/canonical-chat-client";
import { AppError } from "../../../../../shared/app-error";
import { useEffect, useMemo, useRef, useState } from "react";
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

type WorkRailPageState = {
  rows: ChatNavigationRecord[];
  count: number;
  cursor?: string;
  loading: boolean;
  error: boolean;
};
type PageController = { refresh: (version: number) => void; loadMore: () => void };
const EMPTY_PAGE: WorkRailPageState = { rows: [], count: 0, loading: false, error: false };

function appendDistinctRows(rows: ChatNavigationRecord[], items: readonly ChatNavigationRecord[]) {
  for (const item of items) {
    if (!rows.some(row => row.chat.id === item.chat.id)) rows.push(item);
  }
}

/** Each rail placement has its own cursor. Clicks take priority over queued refreshes. */
export function useWorkRailPage(client: CanonicalChatClient | null, query: Pick<CanonicalChatNavigationPageQuery, "group" | "projectId">,
  scopeKey: string, version: number, initialSize: number) {
  const { group, projectId } = query;
  const key = JSON.stringify([scopeKey, group, projectId, initialSize]);
  const controller = useRef<PageController | null>(null);
  const [snapshot, setSnapshot] = useState<{ key: string; client: CanonicalChatClient; page: WorkRailPageState } | null>(null);

  useEffect(() => {
    if (!client?.navigationPage) {
      setSnapshot(null);
      return;
    }

    const pageClient = client;
    let page = EMPTY_PAGE;
    let closed = false;
    let inFlight = false;
    let queuedMore = false;
    let requestedVersion: number | undefined;
    let startedVersion: number | undefined;

    function publish() {
      setSnapshot({ key, client: pageClient, page });
    }

    async function runNext() {
      if (closed || inFlight) return;
      const cursor = queuedMore ? page.cursor : undefined;
      queuedMore = false;
      if (!cursor && startedVersion === requestedVersion) {
        if (page.loading) {
          page = { ...page, loading: false };
          publish();
        }
        return;
      }

      const initial = startedVersion === undefined;
      if (!cursor) startedVersion = requestedVersion;
      inFlight = true;
      if (initial || cursor) {
        page = { ...page, loading: true, error: false };
        publish();
      }

      try {
        const targetCount = Math.max(initialSize, page.rows.length);
        const rows = cursor ? [...page.rows] : [];
        let nextCursor = cursor;
        let count: number;
        do {
          const response = await pageClient.navigationPage({
            group, ...(projectId ? { projectId } : {}), limit: nextCursor ? 20 : initialSize, ...(nextCursor ? { cursor: nextCursor } : {}),
          });
          if (closed) return;
          if (nextCursor && response.nextCursor === nextCursor) throw new Error("Navigation cursor did not advance");
          appendDistinctRows(rows, response.items);
          count = response.totalCount;
          nextCursor = response.nextCursor;
        } while (!cursor && nextCursor && rows.length < targetCount);

        page = { rows, count, cursor: nextCursor, loading: queuedMore && Boolean(nextCursor), error: false };
        publish();
      } catch (cause: unknown) {
        if (closed) return;
        console.warn("[work-rail] Navigation page unavailable:", cause instanceof Error ? cause.name : "UnknownError");
        if (cause instanceof AppError && cause.category === "unauthorized") {
          page = { ...EMPTY_PAGE, error: true };
          queuedMore = false;
        } else {
          page = { ...page, loading: queuedMore, error: true };
        }
        publish();
      } finally {
        inFlight = false;
        void runNext();
      }
    }

    controller.current = {
      refresh(nextVersion) {
        requestedVersion = nextVersion;
        void runNext();
      },
      loadMore() {
        if (!page.cursor || page.loading) return;
        queuedMore = true;
        page = { ...page, loading: true, error: false };
        publish();
        void runNext();
      },
    };
    return () => {
      closed = true;
      controller.current = null;
    };
  }, [client, key, group, projectId, initialSize]);

  useEffect(() => { controller.current?.refresh(version); }, [client, key, version]);
  const page = snapshot && snapshot.key === key && snapshot.client === client
    ? snapshot.page : { ...EMPTY_PAGE, loading: Boolean(client?.navigationPage) };
  return { ...page, loadMore: () => controller.current?.loadMore() };
}
