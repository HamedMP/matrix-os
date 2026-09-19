import { z } from "zod/v4";
import { BackgroundAgentRefSchema } from "../domains/sessions/background-agent-runtime.js";
import type { StoredThread, StoredThreadState, StoredTurn } from "./thread-store.js";
import type { AgentThreadEvent } from "@matrix-os/contracts";

export const BackgroundThreadStopSchema = z.object({
  ownerId: z.string().min(1).max(160),
  workspaceSessionId: z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/),
  backgroundRef: BackgroundAgentRefSchema,
  runtimeStatus: z.enum(["exited", "failed", "degraded"]),
}).strict();
export type BackgroundThreadStop = z.infer<typeof BackgroundThreadStopSchema>;

/** Incarnation matching happens within the same store mutation as the terminal state. */
export function applyBackgroundThreadStop(state: StoredThreadState, input: BackgroundThreadStop, deps: {
  active: (thread: StoredThread) => boolean;
  settle: (turn: StoredTurn, at: string) => StoredTurn;
  events: (threadId: string, status: BackgroundThreadStop["runtimeStatus"]) => AgentThreadEvent[];
  apply: (thread: StoredThread, event: AgentThreadEvent) => StoredThread;
}) {
  const thread = state.threads.find(candidate => candidate.ownerId === input.ownerId
    && candidate.providerResumeState?.conversationId === input.workspaceSessionId
    && candidate.providerResumeState.backgroundRef?.id === input.backgroundRef.id);
  if (!thread || !deps.active(thread)) return { state, result: [] as AgentThreadEvent[] };
  const events = deps.events(thread.id, input.runtimeStatus);
  let next = thread;
  for (const event of events) next = deps.apply(next, event);
  const { activeTurnId, ...rest } = next;
  return {
    state: { ...state, threads: state.threads.map(candidate => candidate === thread ? rest : candidate),
      events: [...state.events, ...events],
      turns: state.turns.map(turn => turn.ownerId === thread.ownerId && turn.threadId === thread.id && turn.turnId === activeTurnId
        ? deps.settle(turn, events.at(-1)!.occurredAt) : turn),
    },
    result: events,
  };
}

export function withBackgroundResumeState(thread: StoredThread, providerResumeState: NonNullable<StoredThread["providerResumeState"]>): StoredThread {
  if (!providerResumeState.backgroundRef) return { ...thread, providerResumeState };
  const { terminalRef: _terminalRef, ...rest } = thread;
  return { ...rest, providerResumeState };
}
