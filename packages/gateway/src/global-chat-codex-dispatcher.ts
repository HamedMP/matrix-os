import type { AgentThreadEvent, GlobalChatProviderId } from "@matrix-os/contracts";
import { randomUUID } from "node:crypto";
import type {
  CodingAgentThreadStore,
  CodingAgentTurnStore,
} from "./coding-agents/thread-store.js";
import type { RequestPrincipal } from "./request-principal.js";

const MAX_ACTIVE_GLOBAL_CODING_AGENT_RUNS = 64;
const MAX_SEEN_EVENTS_PER_RUN = 2_000;
const MAX_TRACKED_TOOLS_PER_RUN = 128;

type GlobalChatCodingAgentProviderId = Exclude<GlobalChatProviderId, "claude">;

function globalChatSandboxMode(providerId: GlobalChatCodingAgentProviderId): "read_only" | "workspace_write" {
  return providerId === "pi" ? "read_only" : "workspace_write";
}

export type GlobalChatCodingAgentFrame =
  | { type: "kernel:init"; sessionId: string; providerId: GlobalChatCodingAgentProviderId; requestId: string }
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
  providerId: GlobalChatCodingAgentProviderId;
  threadId?: string;
  onEvent: (frame: GlobalChatCodingAgentFrame) => void;
  seenEventIds: Set<string>;
  toolNames: Map<string, string>;
  abortRequested: boolean;
  errorEmitted: boolean;
  settled: boolean;
  resolve: (result: { threadId: string }) => void;
  reject: (error: Error) => void;
  removeAbortListener?: () => void;
}

export interface GlobalChatCodingAgentDispatcher {
  dispatch(input: {
    principal: RequestPrincipal;
    providerId: GlobalChatCodingAgentProviderId;
    text: string;
    requestId: string;
    threadId?: string;
    signal?: AbortSignal;
    onEvent: (frame: GlobalChatCodingAgentFrame) => void;
  }): Promise<{ threadId: string }>;
  dispose(): void;
}

function genericCodingAgentFailure(): string {
  return "The coding agent could not complete this turn. Try again.";
}

export function createGlobalChatCodingAgentDispatcher(options: {
  threads: CodingAgentThreadStore & CodingAgentTurnStore;
}): GlobalChatCodingAgentDispatcher {
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
      providerId: run.providerId,
      requestId: run.requestId,
    });
    if (run.abortRequested) {
      void options.threads.abortThread(run.principal, threadId, run.agentRequestId).catch((error: unknown) => {
        console.warn("[global-chat] Coding-agent abort failed after thread initialization", error);
      });
    }
  }

  function processEvents(run: ActiveRun, events: readonly AgentThreadEvent[]): void {
    for (const event of events) {
      if (run.seenEventIds.has(event.eventId)) continue;
      if (run.seenEventIds.size >= MAX_SEEN_EVENTS_PER_RUN) {
        throw new Error("Coding-agent event tracking capacity exceeded");
      }
      run.seenEventIds.add(event.eventId);

      if (event.type === "assistant.text.delta") {
        run.onEvent({ type: "kernel:text", text: event.delta, requestId: run.requestId });
      } else if (event.type === "tool.started") {
        if (!run.toolNames.has(event.toolCallId)) {
          if (run.toolNames.size >= MAX_TRACKED_TOOLS_PER_RUN) {
            throw new Error("Coding-agent tool tracking capacity exceeded");
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
          run.onEvent({ type: "kernel:error", message: genericCodingAgentFailure(), requestId: run.requestId });
        }
      } else if (event.type === "thread.completed") {
        if (event.outcome === "aborted") {
          run.onEvent({ type: "kernel:aborted", requestId: run.requestId });
        } else if (event.outcome === "failed") {
          if (!run.errorEmitted) {
            run.errorEmitted = true;
            run.onEvent({ type: "kernel:error", message: genericCodingAgentFailure(), requestId: run.requestId });
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
      run.reject(error instanceof Error ? error : new Error("Coding-agent event translation failed"));
    }
  });

  return {
    dispatch(input) {
      if (pendingByRequest.size + activeByThread.size >= MAX_ACTIVE_GLOBAL_CODING_AGENT_RUNS) {
        return Promise.reject(new Error("Global coding-agent run capacity exceeded"));
      }
      const hasDuplicateRequest = [...pendingByRequest.values(), ...activeByThread.values()]
        .some((run) => run.requestId === input.requestId);
      if (hasDuplicateRequest) {
        return Promise.reject(new Error("Duplicate Global coding-agent request"));
      }

      return new Promise<{ threadId: string }>((resolve, reject) => {
        const agentRequestId = `req_${randomUUID()}`;
        const run: ActiveRun = {
          principal: input.principal,
          requestId: input.requestId,
          agentRequestId,
          providerId: input.providerId,
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
                console.warn("[global-chat] Coding-agent abort failed", error);
              });
            }
          };
          input.signal.addEventListener("abort", onAbort, { once: true });
          run.removeAbortListener = () => input.signal?.removeEventListener("abort", onAbort);
        }

        const start = input.threadId
          ? options.threads.getThread(input.principal, input.threadId).then((snapshot) => {
              if (snapshot.thread.providerId !== input.providerId) {
                throw new Error("Conversation provider does not match coding-agent thread");
              }
              emitInit(run, input.threadId!);
              return options.threads.acceptTurn(input.principal, input.threadId!, {
                message: input.text,
                clientRequestId: run.agentRequestId,
              });
            })
          : options.threads.createThread(input.principal, {
              providerId: input.providerId,
              prompt: input.text,
              clientRequestId: run.agentRequestId,
              sandboxMode: globalChatSandboxMode(input.providerId),
            }).then((result) => {
              emitInit(run, result.snapshot.thread.id);
              processEvents(run, result.snapshot.events.items);
            });

        void start.catch((error: unknown) => {
          if (run.settled) return;
          run.settled = true;
          cleanup(run);
          reject(error instanceof Error ? error : new Error("Coding-agent dispatch failed"));
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
        run.reject(new Error("Global coding-agent dispatcher closed"));
      }
    },
  };
}
