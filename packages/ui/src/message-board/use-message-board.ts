"use client";

import { useCallback, useEffect, useEffectEvent, useState } from "react";
import type { MessageBoardClient } from "./client.js";
import { messageBoardErrorCopy } from "./presentation.js";
import type {
  BoardActor, BoardChannel, BoardSchedule, BoardSummary, BoardThread, BoardThreadSummary, BoardWatcher,
} from "./types.js";

export type ResourceStatus = "idle" | "loading" | "ready" | "error";

export interface Resource<T> {
  status: ResourceStatus;
  data: T | null;
  error: string | null;
}

const IDLE = { status: "idle", data: null, error: null } as const;
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
  /** Runs a write; the next event (or this call) refreshes every view. */
  mutate(work: (client: MessageBoardClient, board: string) => Promise<unknown>): Promise<MutationResult>;
  reload(): void;
}

export function useMessageBoard(client: MessageBoardClient, initialBoard = "General"): MessageBoardController {
  const [board, setBoard] = useState(initialBoard);
  const [scope, setScope] = useState("*");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((value) => value + 1), []);

  const [eventsPending, setEventsPending] = useState(false);
  useEffect(() => client.subscribe(board, () => setEventsPending(true)), [client, board]);
  useEffect(() => {
    if (!eventsPending) return;
    const timer = setTimeout(() => { setEventsPending(false); bump(); }, EVENT_COALESCE_MS);
    return () => clearTimeout(timer);
  }, [eventsPending, bump]);

  const me = useResource(() => client.whoami(), "me", version);
  const boards = useResource(() => client.listBoards(), "boards", version);
  const actors = useResource(() => client.listActors(board), `actors:${board}`, version);
  const channels = useResource(() => client.listChannels(board), `channels:${board}`, version);
  const threads = useResource(() => client.listThreads(board, scope), `threads:${board}:${scope}`, version);
  const thread = useResource(selectedThreadId ? () => client.getThread(board, selectedThreadId) : null, `thread:${board}:${selectedThreadId ?? ""}`, version);
  const watchers = useResource(() => client.listWatchers(board), `watchers:${board}`, version);
  const schedules = useResource(() => client.listSchedules(board), `schedules:${board}`, version);

  const selectThread = useCallback((id: string | null) => {
    setSelectedThreadId(id);
    if (!id) return;
    client.markRead(board, id).then(bump, (error: unknown) => {
      console.warn("[message-board] mark read failed", error instanceof Error ? error.message : error);
    });
  }, [board, bump, client]);

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
    selectBoard: useCallback((name: string) => { setBoard(name); setScope("*"); setSelectedThreadId(null); }, []),
    selectScope: useCallback((next: string) => { setScope(next); setSelectedThreadId(null); }, []),
    selectThread,
    mutate,
    reload: bump,
  };
}
