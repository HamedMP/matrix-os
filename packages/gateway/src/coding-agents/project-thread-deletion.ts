import type { RequestPrincipal } from "../domains/identity/request-principal.js";
import { boundedOperation } from "../_shared/bounded-operation.js";
import type { StoredThread, StoredThreadState } from "./thread-store.js";
import type { CodingAgentProviderAdapter } from "./provider-adapter.js";

/** Called under the store mutation lock, after the project is fenced for deletion. */
export async function deleteProjectThreadState(input: {
  state: StoredThreadState;
  principal: RequestPrincipal;
  projectId: string;
  providers: readonly CodingAgentProviderAdapter[];
  abortLocal: (thread: StoredThread) => void;
  now: () => Date;
  nextEventId: () => string;
}) {
  const { state, principal, projectId } = input;
  const threads = state.threads.filter(thread => thread.ownerId === principal.userId && thread.projectId === projectId);
  for (const thread of threads) {
    input.abortLocal(thread);
    const provider = input.providers.find(candidate => candidate.providerId === thread.providerId);
    // Stop idle provider sessions too. Missing historical sessions are an idempotent stop.
    if (provider?.abortThread) {
      await boundedOperation(async () => provider.abortThread!({
        principal, thread, clientRequestId: `req_delete_${thread.id}`,
        requireRuntimeStop: true, now: input.now, nextEventId: input.nextEventId,
      }), 10_000);
    }
  }
  const ids = new Set(threads.map(thread => thread.id)); // bounded by the thread store cap
  const refs = new Set(threads.flatMap(thread => thread.terminalRef
    ? [`${thread.terminalRef.workspaceId}:${thread.terminalRef.tabId}`] : []));
  return {
    state: {
      ...state,
      threads: state.threads.filter(thread => !ids.has(thread.id)),
      events: state.events.filter(event => !ids.has(event.threadId)),
      turns: state.turns.filter(turn => !ids.has(turn.threadId)),
      pendingTerminalStops: state.pendingTerminalStops.filter(stop => !("terminalRef" in stop)
        || stop.ownerId !== principal.userId || !refs.has(`${stop.terminalRef.workspaceId}:${stop.terminalRef.tabId}`)),
    },
    result: { ok: true as const, deleted: threads.length },
  };
}
