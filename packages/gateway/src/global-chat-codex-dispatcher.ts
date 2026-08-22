import type { AgentThreadEvent } from "@matrix-os/contracts";
import { randomUUID } from "node:crypto";
import type {
  CodingAgentThreadStore,
  CodingAgentTurnStore,
} from "./coding-agents/thread-store.js";
import type { RequestPrincipal } from "./request-principal.js";

const MAX_ACTIVE_GLOBAL_CODEX_RUNS = 64;
const MAX_SEEN_EVENTS_PER_RUN = 2_000;
const MAX_TRACKED_TOOLS_PER_RUN = 128;

export type GlobalChatCodexFrame =
  | { type: "kernel:init"; sessionId: string; providerId: "codex"; requestId: string }
  | { type: "kernel:text"; text: string; requestId: string }
  | { type: "kernel:tool_start"; tool: string; requestId: string }
  | { type: "kernel:tool_end"; input: { outcome: string }; requestId: string }
  | { type: "kernel:result"; data: { outcome: "completed" }; requestId: string }
  | { type: "kernel:error"; message: string; requestId: string }
  | { type: "kernel:aborted"; requestId: string };

interface ActiveRun {
  principal: RequestPrincipal;
  requestId: string;
  agentRequestId: string;
  threadId?: string;
  onEvent: (frame: GlobalChatCodexFrame) => void;
  seenEventIds: Set<string>;
  toolNames: Map<string, string>;
  abortRequested: boolean;
  errorEmitted: boolean;
  settled: boolean;
  resolve: (result: { threadId: string }) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
}

export interface GlobalChatCodexDispatcher {
  dispatch(input: {
    principal: RequestPrincipal;
    text: string;
    requestId: string;
    threadId?: string;
    signal?: AbortSignal;
    onEvent: (frame: GlobalChatCodexFrame) => void;
  }): Promise<{ threadId: string }>;
  dispose(): void;
}

function genericCodexFailure(): string {
  return "Codex could not complete this turn. Try again.";
}

export function createGlobalChatCodexDispatcher(options: {
  threads: CodingAgentThreadStore & CodingAgentTurnStore;
}): GlobalChatCodexDispatcher {
  const pendingByRequest = new Map<string, ActiveRun>();
  const activeByThread = new Map<string, ActiveRun>();

  function cleanup(run: ActiveRun): void {
    pendingByRequest.delete(run.agentRequestId);
    if (run.threadId) activeByThread.delete(run.threadId);
    run.removeAbortListener?.();
    run.seenEventIds.clear();
    run.toolNames.clear();
  }

  function finish(run: ActiveRun): void {
    if (run.settled || !run.threadId) return;
    run.settled = true;
    const threadId = run.threadId;
    cleanup(run);
    run.resolve({ threadId });
  }

  function emitInit(run: ActiveRun, threadId: string): void {
    if (run.threadId) return;
    run.threadId = threadId;
    pendingByRequest.delete(run.agentRequestId);
    activeByThread.set(threadId, run);
    run.onEvent({
      type: "kernel:init",
      sessionId: threadId,
      providerId: "codex",
      requestId: run.requestId,
    });
    if (run.abortRequested) {
      void options.threads.abortThread(run.principal, threadId, run.agentRequestId).catch((error: unknown) => {
        console.warn("[global-chat] Codex abort failed after thread initialization", error);
      });
    }
  }

  function processEvents(run: ActiveRun, events: readonly AgentThreadEvent[]): void {
    for (const event of events) {
      if (run.seenEventIds.has(event.eventId)) continue;
      if (run.seenEventIds.size >= MAX_SEEN_EVENTS_PER_RUN) {
        throw new Error("Codex event tracking capacity exceeded");
      }
      run.seenEventIds.add(event.eventId);

      if (event.type === "assistant.text.delta") {
        run.onEvent({ type: "kernel:text", text: event.delta, requestId: run.requestId });
      } else if (event.type === "tool.started") {
        if (!run.toolNames.has(event.toolCallId)) {
          if (run.toolNames.size >= MAX_TRACKED_TOOLS_PER_RUN) {
            throw new Error("Codex tool tracking capacity exceeded");
          }
          run.toolNames.set(event.toolCallId, event.displayName);
        }
        run.onEvent({ type: "kernel:tool_start", tool: event.displayName, requestId: run.requestId });
      } else if (event.type === "tool.completed") {
        run.onEvent({
          type: "kernel:tool_end",
          input: { outcome: event.outcome },
          requestId: run.requestId,
        });
        run.toolNames.delete(event.toolCallId);
      } else if (event.type === "thread.error") {
        if (!run.errorEmitted) {
          run.errorEmitted = true;
          run.onEvent({ type: "kernel:error", message: genericCodexFailure(), requestId: run.requestId });
        }
      } else if (event.type === "thread.completed") {
        if (event.outcome === "aborted") {
          run.onEvent({ type: "kernel:aborted", requestId: run.requestId });
        } else if (event.outcome === "failed") {
          if (!run.errorEmitted) {
            run.errorEmitted = true;
            run.onEvent({ type: "kernel:error", message: genericCodexFailure(), requestId: run.requestId });
          }
        } else {
          run.onEvent({
            type: "kernel:result",
            data: { outcome: "completed" },
            requestId: run.requestId,
          });
        }
        finish(run);
      }
    }
  }

  const sink = options.threads.registerEventSink(({ ownerId, threadId, events }) => {
    let run = activeByThread.get(threadId);
    if (!run) {
      const requestEvent = events.find((event) =>
        event.type === "user.message" && pendingByRequest.has(event.clientRequestId)
      );
      if (requestEvent?.type === "user.message") {
        const candidate = pendingByRequest.get(requestEvent.clientRequestId);
        if (candidate?.principal.userId === ownerId) {
          emitInit(candidate, threadId);
          run = candidate;
        }
      }
    }
    if (!run || run.principal.userId !== ownerId || run.settled) return;
    try {
      processEvents(run, events);
    } catch (error: unknown) {
      run.settled = true;
      cleanup(run);
      run.reject(error instanceof Error ? error : new Error("Codex event translation failed"));
    }
  });

  return {
    dispatch(input) {
      if (pendingByRequest.size + activeByThread.size >= MAX_ACTIVE_GLOBAL_CODEX_RUNS) {
        return Promise.reject(new Error("Global Codex run capacity exceeded"));
      }
      const hasDuplicateRequest = [...pendingByRequest.values(), ...activeByThread.values()]
        .some((run) => run.requestId === input.requestId);
      if (hasDuplicateRequest) {
        return Promise.reject(new Error("Duplicate Global Codex request"));
      }

      return new Promise<{ threadId: string }>((resolve, reject) => {
        const agentRequestId = `req_${randomUUID()}`;
        const run: ActiveRun = {
          principal: input.principal,
          requestId: input.requestId,
          agentRequestId,
          onEvent: input.onEvent,
          seenEventIds: new Set(),
          toolNames: new Map(),
          abortRequested: input.signal?.aborted ?? false,
          errorEmitted: false,
          settled: false,
          resolve,
          reject,
        };
        pendingByRequest.set(agentRequestId, run);

        if (input.signal) {
          const onAbort = () => {
            run.abortRequested = true;
            if (run.threadId) {
              void options.threads.abortThread(
                run.principal,
                run.threadId,
                run.agentRequestId,
              ).catch((error: unknown) => {
                console.warn("[global-chat] Codex abort failed", error);
              });
            }
          };
          input.signal.addEventListener("abort", onAbort, { once: true });
          run.removeAbortListener = () => input.signal?.removeEventListener("abort", onAbort);
        }

        const start = input.threadId
          ? options.threads.getThread(input.principal, input.threadId).then((snapshot) => {
              if (snapshot.thread.providerId !== "codex") {
                throw new Error("Conversation provider does not match Codex thread");
              }
              emitInit(run, input.threadId!);
              return options.threads.acceptTurn(input.principal, input.threadId!, {
                message: input.text,
                clientRequestId: run.agentRequestId,
              });
            })
          : options.threads.createThread(input.principal, {
              providerId: "codex",
              prompt: input.text,
              clientRequestId: run.agentRequestId,
            }).then((result) => {
              emitInit(run, result.snapshot.thread.id);
              processEvents(run, result.snapshot.events.items);
            });

        void start.catch((error: unknown) => {
          if (run.settled) return;
          run.settled = true;
          cleanup(run);
          reject(error instanceof Error ? error : new Error("Codex dispatch failed"));
        });
      });
    },
    dispose() {
      sink.dispose();
      const runs = new Set([...pendingByRequest.values(), ...activeByThread.values()]);
      for (const run of runs) {
        if (run.settled) continue;
        run.settled = true;
        cleanup(run);
        run.reject(new Error("Global Codex dispatcher closed"));
      }
    },
  };
}
