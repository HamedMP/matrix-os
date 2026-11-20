"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyPendingMoves, groupTasksByStatus, planMove, type BoardColumns, type PendingMove } from "./board-model.js";
import {
  GENERIC_BOARD_ERROR, ProjectBoardRequestError, TaskAgentWorkingError, TaskConflictError,
  type CreateTaskInput, type ProjectBoardClient, type UpdateTaskInput,
} from "./client.js";
import type { BoardMember, BoardSettings, ProjectTask, TaskStatus } from "./types.js";

export interface ProjectBoardState {
  status: "loading" | "ready" | "error";
  /** Server tasks with optimistic moves applied. */
  tasks: readonly ProjectTask[];
  columns: BoardColumns;
  members: readonly BoardMember[];
  settings: BoardSettings | null;
  /** A short, safe message for the last failed action. */
  notice: string | null;
  dismissNotice(): void;
  retry(): void;
  /**
   * `column` is the target column as the person sees it (filters applied); defaults to the full column.
   * Resolves `agent_working` when the server wants confirmation first: repeat with `force` once the person agrees.
   */
  moveTask(taskId: string, status: TaskStatus, targetIndex: number, column?: readonly ProjectTask[], options?: { force?: boolean }): Promise<MoveResult>;
  createTask(input: Omit<CreateTaskInput, "clientRequestId">): Promise<ProjectTask | null>;
  /**
   * Saves against `task.revision`. A lost race resolves `{ conflict }` with the server's copy; unless the caller
   * says it resolves conflicts itself, the board also shows a notice.
   */
  updateTask(task: ProjectTask, input: UpdateTaskInput, options?: { resolvesConflict?: boolean }): Promise<UpdateResult>;
  /** Run any other client call with the board's error handling; refreshes on success. */
  run<T>(action: () => Promise<T>, failure: string): Promise<T | null>;
}

export type MoveResult = "moved" | "failed" | "agent_working";
export type UpdateResult = { task: ProjectTask; conflict?: undefined } | { task?: undefined; conflict: ProjectTask } | { task?: undefined; conflict?: undefined };

const NO_MEMBERS: readonly BoardMember[] = [];

/** Shown text is always one of these or a client `ProjectBoardRequestError` message, never a raw error. */
function safeMessage(error: unknown, fallback: string): string {
  if (error instanceof ProjectBoardRequestError && error.message !== GENERIC_BOARD_ERROR && error.message.length <= 120) return error.message;
  return fallback;
}

/** `req_<id>`, as the contract's `clientRequestId` requires. */
function requestId(): string {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `req_${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * Loads a project's board from a `ProjectBoardClient`, refetches on its change
 * signals and applies card moves optimistically: a move shows at once and snaps
 * back with a generic notice if the client rejects it.
 */
export function useProjectBoard(client: ProjectBoardClient, options: { includeArchived?: boolean } = {}): ProjectBoardState {
  const includeArchived = options.includeArchived ?? false;
  const [server, setServer] = useState<{ client: ProjectBoardClient; tasks: readonly ProjectTask[] } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [members, setMembers] = useState<readonly BoardMember[]>(NO_MEMBERS);
  const [settings, setSettings] = useState<BoardSettings | null>(null);
  const [pending, setPending] = useState<Record<string, PendingMove>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const generation = useRef(0);
  // In-flight moves only: an entry is removed when its task's last queued move settles.
  const moveQueue = useRef(new Map<string, { seq: number; tail: Promise<void> }>());
  const moveSeq = useRef(0);

  const refresh = useCallback(async () => {
    const current = (generation.current += 1);
    try {
      const tasks = await client.listTasks({ includeArchived });
      if (generation.current !== current) return;
      setServer({ client, tasks });
      setLoadError(false);
    } catch (error: unknown) {
      if (generation.current !== current) return;
      console.warn("[project-board] tasks could not be loaded", error instanceof Error ? error.name : typeof error);
      setLoadError(true);
    }
  }, [client, includeArchived]);

  useEffect(() => {
    void refresh();
    // A burst of change signals (one poll can carry several) costs one refetch.
    let queued = false;
    return client.subscribe(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; void refresh(); });
    });
  }, [client, refresh, reloadKey]);

  useEffect(() => {
    let live = true;
    Promise.all([client.listMembers(), client.getSettings()]).then(([nextMembers, nextSettings]) => {
      if (!live) return;
      setMembers(nextMembers);
      setSettings(nextSettings);
    }, (error: unknown) => {
      console.warn("[project-board] board details could not be loaded", error instanceof Error ? error.name : typeof error);
    });
    return () => { live = false; };
  }, [client, reloadKey]);

  const serverTasks = server?.client === client ? server.tasks : null;
  const tasks = useMemo(() => applyPendingMoves(serverTasks ?? [], pending), [serverTasks, pending]);
  const columns = useMemo(() => groupTasksByStatus(tasks), [tasks]);

  const moveTask = useCallback(async (taskId: string, status: TaskStatus, targetIndex: number, column?: readonly ProjectTask[], options: { force?: boolean } = {}): Promise<MoveResult> => {
    const plan = planMove(column ?? columns[status], taskId, targetIndex);
    setPending((current) => ({ ...current, [taskId]: { status, rank: plan.rank } }));
    // One move per task on the wire at a time: the next starts once the previous settles, so replies cannot cross.
    const queue = moveQueue.current;
    const previous = queue.get(taskId);
    const seq = (moveSeq.current += 1);
    const send = () => client.moveTask(taskId, {
      status, afterTaskId: plan.afterTaskId, beforeTaskId: plan.beforeTaskId, ...(options.force ? { force: true } : {}),
    });
    // The executor runs at once, so an idle task's move is sent without waiting a tick.
    const sent = previous ? previous.tail.then(send) : new Promise<ProjectTask>((resolve) => { resolve(send()); });
    queue.set(taskId, { seq, tail: sent.then(() => undefined, () => undefined) });
    try {
      const moved = await sent;
      // A refetch may already hold a newer copy than this reply.
      setServer((current) => current && current.client === client
        ? { client, tasks: current.tasks.map((task) => (task.id === moved.id && moved.revision >= task.revision ? moved : task)) } : current);
      return "moved";
    } catch (error: unknown) {
      if (error instanceof TaskAgentWorkingError) return "agent_working";
      console.warn("[project-board] move failed", error instanceof Error ? error.name : typeof error);
      setNotice(safeMessage(error, "Couldn't move the task. It's back where it was."));
      return "failed";
    } finally {
      // A later move for this task still owns the optimistic position until it settles.
      if (queue.get(taskId)?.seq === seq) {
        queue.delete(taskId);
        setPending((current) => {
          if (!(taskId in current)) return current;
          const { [taskId]: _settled, ...rest } = current;
          return rest;
        });
      }
    }
  }, [client, columns]);

  const run = useCallback(async <T,>(action: () => Promise<T>, failure: string): Promise<T | null> => {
    try {
      const result = await action();
      void refresh();
      return result;
    } catch (error: unknown) {
      console.warn("[project-board] action failed", error instanceof Error ? error.name : typeof error);
      setNotice(safeMessage(error, failure));
      return null;
    }
  }, [refresh]);

  const createTask = useCallback((input: Omit<CreateTaskInput, "clientRequestId">) =>
    run(() => client.createTask({ ...input, clientRequestId: requestId() }), "Couldn't create the task. Try again."), [client, run]);

  const updateTask = useCallback(async (task: ProjectTask, input: UpdateTaskInput, options: { resolvesConflict?: boolean } = {}): Promise<UpdateResult> => {
    try {
      const updated = await client.updateTask(task.id, task.revision, input);
      void refresh();
      return { task: updated };
    } catch (error: unknown) {
      if (error instanceof TaskConflictError) {
        if (!options.resolvesConflict) setNotice("Someone else changed this task. Showing their version — make your edit again.");
        void refresh();
        return { conflict: error.current };
      }
      console.warn("[project-board] update failed", error instanceof Error ? error.name : typeof error);
      setNotice(safeMessage(error, "Couldn't save the change. Try again."));
      return {};
    }
  }, [client, refresh]);

  return {
    status: serverTasks ? "ready" : loadError ? "error" : "loading",
    tasks, columns, members, settings, notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    retry: useCallback(() => setReloadKey((key) => key + 1), []),
    moveTask, createTask, updateTask, run,
  };
}
