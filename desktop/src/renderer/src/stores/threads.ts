// Agent threads store (data-model.md AgentThread): Codex-style parallel runs
// multiplexed over one kernel socket, routed by requestId through the ported
// chat reducer. State stays serializable (arrays only).
import { create } from "zustand";
import { reduceChat, type ChatMessage } from "../lib/chat";
import {
  KnownKernelMessageSchema,
  type KernelServerMessage,
} from "../lib/kernel-socket";

export type ThreadStatus = "running" | "needs-attention" | "done" | "failed" | "aborted";

export interface AgentThread {
  id: string;
  requestId: string;
  sessionId: string | null;
  taskId: string | null;
  title: string;
  status: ThreadStatus;
  transcript: ChatMessage[];
  unread: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadNotification {
  threadId: string;
  kind: "done" | "failed" | "attention";
  title: string;
  body: string;
}

export interface StartThreadInput {
  text: string;
  title?: string;
  taskId?: string | null;
  sessionId?: string | null;
  requestId: string;
  now?: number;
}

export interface HandleKernelMessageOptions {
  focusedThreadId?: string | null;
  now?: number;
}

interface ThreadsState {
  threads: AgentThread[];
  activeThreadId: string | null;
  startThread(input: StartThreadInput): AgentThread;
  handleKernelMessage(
    msg: KernelServerMessage,
    opts?: HandleKernelMessageOptions,
  ): { notification?: ThreadNotification };
  abortThread(id: string): { requestId: string } | null;
  setActiveThread(id: string | null): void;
  unreadCount(): number;
}

const MAX_THREADS = 100;
const MAX_TRANSCRIPT_MESSAGES = 500;
const MAX_TITLE_LENGTH = 80;

const NOTIFICATION_BODY: Record<ThreadNotification["kind"], string> = {
  done: "Run completed",
  failed: "Run failed",
  attention: "Approval needed",
};

let threadSeq = 0;
function newThreadId(now: number): string {
  threadSeq = (threadSeq + 1) & 0xffff;
  return `thread-${now}-${threadSeq}`;
}

function isTerminal(status: ThreadStatus): boolean {
  return status === "done" || status === "failed" || status === "aborted";
}

function capThreads(threads: AgentThread[]): AgentThread[] {
  if (threads.length <= MAX_THREADS) return threads;
  let excess = threads.length - MAX_THREADS;
  const drop: Record<string, true> = {};
  // Newest first: walk from the oldest end, dropping finished threads first.
  for (let i = threads.length - 1; i >= 0 && excess > 0; i--) {
    const thread = threads[i]!;
    if (isTerminal(thread.status)) {
      drop[thread.id] = true;
      excess--;
    }
  }
  let result = threads.filter((t) => !drop[t.id]);
  // Hard bound: if everything is still live, drop the oldest regardless.
  if (result.length > MAX_THREADS) result = result.slice(0, MAX_THREADS);
  return result;
}

function capTranscript(transcript: ChatMessage[]): ChatMessage[] {
  if (transcript.length <= MAX_TRANSCRIPT_MESSAGES) return transcript;
  return transcript.slice(transcript.length - MAX_TRANSCRIPT_MESSAGES);
}

function patchThread(
  threads: AgentThread[],
  id: string,
  patch: Partial<AgentThread>,
): AgentThread[] {
  return threads.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

export const useThreads = create<ThreadsState>()((set, get) => ({
  threads: [],
  activeThreadId: null,

  startThread: (input) => {
    const now = input.now ?? Date.now();
    const thread: AgentThread = {
      id: newThreadId(now),
      requestId: input.requestId,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      title: (input.title ?? input.text).slice(0, MAX_TITLE_LENGTH),
      status: "running",
      transcript: [
        {
          id: `user-${now}-${threadSeq}`,
          role: "user",
          content: input.text,
          requestId: input.requestId,
          timestamp: now,
        },
      ],
      unread: false,
      createdAt: now,
      updatedAt: now,
    };
    set({ threads: capThreads([thread, ...get().threads]) });
    return thread;
  },

  handleKernelMessage: (msg, opts) => {
    const rawMessage = msg as unknown as { requestId?: unknown };
    const rawRequestId =
      typeof rawMessage.requestId === "string" ? rawMessage.requestId : undefined;
    const parsed = KnownKernelMessageSchema.safeParse(msg);
    if (!parsed.success) return {};
    const event = parsed.data;
    const now = opts?.now ?? Date.now();
    const state = get();
    const focusedId =
      opts?.focusedThreadId !== undefined ? opts.focusedThreadId : state.activeThreadId;

    const byRequestId = (requestId: string | undefined): AgentThread | undefined =>
      requestId ? state.threads.find((t) => t.requestId === requestId) : undefined;

    const apply = (
      thread: AgentThread,
      patch: Partial<AgentThread>,
      transition?: ThreadNotification["kind"],
    ): { notification?: ThreadNotification } => {
      const unfocused = thread.id !== focusedId;
      set({
        threads: patchThread(state.threads, thread.id, {
          ...patch,
          unread: unfocused ? true : thread.unread,
          updatedAt: now,
        }),
      });
      if (transition && unfocused) {
        return {
          notification: {
            threadId: thread.id,
            kind: transition,
            title: thread.title,
            body: NOTIFICATION_BODY[transition],
          },
        };
      }
      return {};
    };

    switch (event.type) {
      case "kernel:init": {
        // Match by requestId; otherwise bind only when exactly one running thread
        // is still awaiting its first session (unambiguous), else drop.
        const unbound = state.threads.filter((t) => t.status === "running" && t.sessionId === null);
        const thread = byRequestId(event.requestId) ?? (unbound.length === 1 ? unbound[0] : undefined);
        if (!thread) return {};
        return apply(thread, { sessionId: event.sessionId });
      }
      case "session:switched": {
        // Prefer the active thread; otherwise bind only when exactly one thread
        // is running (unambiguous). Binding by array order under concurrent runs
        // would attach the session to the wrong thread.
        const running = state.threads.filter((t) => t.status === "running");
        const thread =
          state.threads.find((t) => t.id === state.activeThreadId && t.status === "running") ??
          (running.length === 1 ? running[0] : undefined);
        if (!thread) return {};
        return apply(thread, { sessionId: event.sessionId });
      }
      case "kernel:text":
      case "kernel:tool_start":
      case "kernel:tool_end": {
        const thread = byRequestId(event.requestId);
        if (!thread) return {};
        return apply(thread, { transcript: capTranscript(reduceChat(thread.transcript, event)) });
      }
      case "kernel:result": {
        const thread = byRequestId(event.requestId);
        if (!thread || isTerminal(thread.status)) return {};
        return apply(thread, { status: "done" }, "done");
      }
      case "kernel:error": {
        const thread = byRequestId(event.requestId);
        if (!thread || isTerminal(thread.status)) return {};
        return apply(
          thread,
          {
            status: "failed",
            transcript: capTranscript(reduceChat(thread.transcript, event)),
          },
          "failed",
        );
      }
      case "kernel:aborted": {
        const thread = byRequestId(event.requestId);
        if (!thread) return {};
        if (isTerminal(thread.status)) return {};
        return apply(thread, {
          status: "aborted",
          transcript: capTranscript(reduceChat(thread.transcript, event)),
        });
      }
      case "approval:request": {
        // Match by requestId; otherwise fall back only when exactly one thread
        // is running (unambiguous). With multiple running threads, guessing by
        // array order would flag the wrong one, so drop the event instead.
        const running = state.threads.filter((t) => t.status === "running");
        let thread: AgentThread | undefined;
        if (rawRequestId) {
          const matched = byRequestId(rawRequestId);
          if (!matched || isTerminal(matched.status)) return {};
          thread = matched;
        } else {
          thread = running.length === 1 ? running[0] : undefined;
        }
        if (!thread) return {};
        return apply(thread, { status: "needs-attention" }, "attention");
      }
      default:
        return {};
    }
  },

  abortThread: (id) => {
    const thread = get().threads.find((t) => t.id === id);
    if (!thread || isTerminal(thread.status)) return null;
    // Status stays as-is until the kernel confirms with kernel:aborted.
    return { requestId: thread.requestId };
  },

  setActiveThread: (id) => {
    const { threads } = get();
    set({
      activeThreadId: id,
      threads: id ? patchThread(threads, id, { unread: false }) : threads,
    });
  },

  unreadCount: () => get().threads.reduce((count, t) => count + (t.unread ? 1 : 0), 0),
}));
