"use client";

import { useCallback, useDeferredValue, useEffect, useEffectEvent, useState } from "react";
import { parseLabelFilter } from "./model.js";
import type { MessageBoardClient } from "./client.js";
import { messageBoardErrorCopy } from "./presentation.js";
import type {
  BoardActor, BoardChannel, BoardSchedule, BoardSummary, BoardThread, BoardThreadFilter, BoardThreadSummary, BoardViewMode, BoardWatcher,
} from "./types.js";

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
  error: string | null;
}

const IDLE = { status: "idle", data: null, error: null } as const;
const THREAD_PAGE = 100;
const MAX_THREAD_LIMIT = 500;
/** Bursts of events (an agent posting and renewing) settle into one reload. */
const EVENT_COALESCE_MS = 60;

/**
 * Loads one value for `key` and reloads it when `version` moves. Stale
 * responses for an old key are dropped; the previous data stays visible
 * while a reload is in flight so live updates never flash a spinner.
 */
function useResource<T>(load: (() => Promise<T>) | null, key: string, version: number): Resource<T> {
  const [state, setState] = useState<Resource<T> & { key: string }>({ ...IDLE, key: "" });
  const enabled = load !== null;
  const runLoad = useEffectEvent(() => load!());
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    runLoad().then(
      (data) => { if (current) setState({ status: "ready", data, error: null, key }); },
      (error: unknown) => {
        if (!current) return;
        console.warn("[message-board] load failed", key, error instanceof Error ? error.message : error);
        setState((previous) => ({ status: "error", data: previous.key === key ? previous.data : null, error: messageBoardErrorCopy(error), key }));
      },
    );
    return () => { current = false; };
  }, [key, version, enabled]);
  if (!enabled) return IDLE;
  return state.key === key ? state : { status: "loading", data: null, error: null };
}

export type MutationResult = { ok: true } | { ok: false; error: string };

export interface MessageBoardController {
  me: Resource<BoardActor>;
  boards: Resource<BoardSummary[]>;
  actors: Resource<BoardActor[]>;
  channels: Resource<BoardChannel[]>;
  threads: Resource<BoardThreadSummary[]>;
  thread: Resource<BoardThread>;
  watchers: Resource<BoardWatcher[]>;
  schedules: Resource<BoardSchedule[]>;
  board: string;
  scope: string;
  selectedThreadId: string | null;
  selectBoard(name: string): void;
  selectScope(scope: string): void;
  selectThread(id: string | null): void;
  mode: BoardViewMode;
  filter: BoardThreadFilter;
  limit: number;
  setMode(mode: BoardViewMode): void;
  setFilter(patch: Partial<BoardThreadFilter>): void;
  /** Asks the board for more threads, up to its page maximum. */
  showMore(): void;
  /** Marks a thread read again, e.g. when a reply arrives while it is on screen. */
  markRead(id: string): void;
  /** Runs a write; the next event (or this call) refreshes every view. */
  mutate(work: (client: MessageBoardClient, board: string) => Promise<unknown>): Promise<MutationResult>;
  reload(): void;
}

export function useMessageBoard(client: MessageBoardClient, initialBoard = "General"): MessageBoardController {
  const [board, setBoard] = useState(initialBoard);
  const [scope, setScope] = useState("*");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [mode, setMode] = useState<BoardViewMode>("threads");
  const [filter, setFilterState] = useState<BoardThreadFilter>({});
  const [limit, setLimit] = useState(THREAD_PAGE);
  // Typing in search must not refetch on every keystroke.
  const deferredText = useDeferredValue(filter.text ?? "");
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((value) => value + 1), []);

  const [eventsPending, setEventsPending] = useState(false);
  useEffect(() => client.subscribe(board, () => setEventsPending(true), () => setEventsPending(true)), [client, board]);
  useEffect(() => {
    if (!eventsPending) return;
    const timer = setTimeout(() => { setEventsPending(false); bump(); }, EVENT_COALESCE_MS);
    return () => clearTimeout(timer);
  }, [eventsPending, bump]);

  const me = useResource(() => client.whoami(), "me", version);
  const boards = useResource(() => client.listBoards(), "boards", version);
  const actors = useResource(() => client.listActors(board), `actors:${board}`, version);
  const channels = useResource(() => client.listChannels(board), `channels:${board}`, version);
  const query = {
    ...(filter.label && parseLabelFilter(filter.label) ? { label: filter.label.trim() } : {}),
    ...(filter.author ? { author: filter.author } : {}),
    ...(filter.taskState ? { taskState: filter.taskState } : {}),
    ...(deferredText.trim() ? { text: deferredText.trim() } : {}),
    ...(mode === "tasks" ? { tasksOnly: true } : {}),
    limit,
  };
  const queryKey = JSON.stringify(query);
  const threads = useResource(() => client.listThreads(board, scope, query), `threads:${board}:${scope}:${queryKey}`, version);
  const thread = useResource(selectedThreadId ? () => client.getThread(board, selectedThreadId) : null, `thread:${board}:${selectedThreadId ?? ""}`, version);
  const watchers = useResource(() => client.listWatchers(board), `watchers:${board}`, version);
  const schedules = useResource(() => client.listSchedules(board), `schedules:${board}`, version);

  const markRead = useCallback((id: string) => {
    client.markRead(board, id).then(bump, (error: unknown) => {
      console.warn("[message-board] mark read failed", error instanceof Error ? error.message : error);
    });
  }, [board, bump, client]);

  const selectThread = useCallback((id: string | null) => {
    setSelectedThreadId(id);
    if (id) markRead(id);
  }, [markRead]);

  const mutate = useCallback(async (work: (client: MessageBoardClient, board: string) => Promise<unknown>): Promise<MutationResult> => {
    try {
      await work(client, board);
      bump();
      return { ok: true };
    } catch (error) {
      console.warn("[message-board] write failed", error instanceof Error ? error.message : error);
      bump();
      return { ok: false, error: messageBoardErrorCopy(error) };
    }
  }, [board, bump, client]);

  return {
    me, boards, actors, channels, threads, thread, watchers, schedules, board, scope, selectedThreadId,
    selectBoard: useCallback((name: string) => { setBoard(name); setScope("*"); setSelectedThreadId(null); setLimit(THREAD_PAGE); }, []),
    selectScope: useCallback((next: string) => { setScope(next); setSelectedThreadId(null); setLimit(THREAD_PAGE); }, []),
    selectThread,
    mode, filter, limit,
    setMode: useCallback((next: BoardViewMode) => { setMode(next); setLimit(THREAD_PAGE); }, []),
    setFilter: useCallback((patch: Partial<BoardThreadFilter>) => { setFilterState((current) => ({ ...current, ...patch })); setLimit(THREAD_PAGE); }, []),
    showMore: useCallback(() => setLimit((current) => Math.min(current + THREAD_PAGE, MAX_THREAD_LIMIT)), []),
    markRead,
    mutate,
    reload: bump,
  };
}
