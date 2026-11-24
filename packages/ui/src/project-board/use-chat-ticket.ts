"use client";

import { useCallback, useEffect, useState } from "react";
import { TaskAgentWorkingError, TaskConflictError, type ProjectBoardClient, type UpdateTaskInput } from "./client.js";
import type { BoardMember, ProjectTask, TaskSession, TaskStatus } from "./types.js";

export interface ChatTicketState {
  /** The chat's ticket; null while loading, for a chat outside a project, or when the board is unavailable. */
  task: ProjectTask | null;
  members: readonly BoardMember[];
  busy: boolean;
  /** A short, safe message for the last failed edit; cleared by the next edit. */
  notice: string | null;
  update(input: UpdateTaskInput): Promise<void>;
  setStatus(status: TaskStatus): Promise<void>;
  /** Attaches a new terminal to the ticket; resolves to it, or null when it could not start. */
  startTerminal(): Promise<TaskSession | null>;
}

const FAILED_SAVE = "Couldn't save the change. Try again.";
const FAILED_TERMINAL = "Couldn't start the terminal. Try again.";

/**
 * The ticket of one chat (every task is a chat), kept fresh from board change
 * signals. Edits go through the board client; a lost revision race reloads the
 * server copy instead of overwriting it.
 */
export function useChatTicket(client: ProjectBoardClient | null, chatId: string | null): ChatTicketState {
  const [task, setTask] = useState<ProjectTask | null>(null);
  const [members, setMembers] = useState<readonly BoardMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!client || !chatId) return;
    try {
      const found = await client.findTaskByChat(chatId);
      setTask((current) => (found && current && current.id === found.id && current.revision > found.revision ? current : found));
    } catch (error: unknown) {
      console.warn("[project-board] chat ticket could not be loaded", error instanceof Error ? error.name : typeof error);
    }
  }, [client, chatId]);

  useEffect(() => {
    setTask(null);
    if (!client || !chatId) return;
    let live = true;
    void reload();
    client.listMembers().then((list) => { if (live) setMembers(list); }, (error: unknown) => {
      console.warn("[project-board] members could not be loaded", error instanceof Error ? error.name : typeof error);
    });
    const unsubscribe = client.subscribe(() => { if (live) void reload(); });
    return () => { live = false; unsubscribe(); };
  }, [client, chatId, reload]);

  // Notices are fixed copy chosen per action; server error text is never shown here.
  const write = async (action: (current: ProjectTask) => Promise<ProjectTask>, failure = FAILED_SAVE) => {
    if (!client || !task) return;
    setBusy(true);
    setNotice(null);
    try {
      setTask(await action(task));
    } catch (error: unknown) {
      if (error instanceof TaskConflictError) {
        setTask(error.current);
        setNotice("Someone else changed this ticket. Showing their version.");
      } else if (error instanceof TaskAgentWorkingError) {
        setNotice("The agent is still working. Close the task from the board to confirm.");
      } else {
        console.warn("[project-board] ticket edit failed", error instanceof Error ? error.name : typeof error);
        setNotice(failure);
      }
    } finally {
      setBusy(false);
    }
  };

  return {
    task, members, busy, notice,
    update: (input) => write((current) => client!.updateTask(current.id, current.revision, input)),
    setStatus: (status) => write((current) => (current.status === status ? Promise.resolve(current) : client!.moveTask(current.id, { status }))),
    startTerminal: async () => {
      let session: TaskSession | null = null;
      await write(async (current) => {
        const started = await client!.startWork(current.id, { kind: "terminal" });
        session = started.session;
        return started.task;
      }, FAILED_TERMINAL);
      return session;
    },
  };
}
