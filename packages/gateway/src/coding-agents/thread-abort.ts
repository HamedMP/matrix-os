import type { AgentThreadEvent, AgentThreadSnapshot, AgentThreadSummary } from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import { boundedOperation } from "../bounded-operation.js";
import { logCodingAgentWarning } from "./diagnostics.js";
import { parseCodingAgentProviderEvents, type CodingAgentProviderAdapter } from "./provider-adapter.js";
import { defaultAbortEvents } from "./thread-fallback-events.js";
import type { StoredThread, StoredThreadState, StoredTurn } from "./thread-store.js";

/** Internal execution fence; absence preserves the public thread-wide cancel API. */
export type CodingAbortScope = { initialRequestId: string } | { turnId: string };

function matchesExecution(thread: StoredThread, state: StoredThreadState, scope: CodingAbortScope): boolean {
  if ("turnId" in scope) return (thread.activeTurnId ?? thread.deliveredTurnId) === scope.turnId;
  return thread.clientRequestId === scope.initialRequestId && !thread.activeTurnId && !thread.deliveredTurnId
    && !state.turns.some((turn) => turn.threadId === thread.id && turn.ownerId === thread.ownerId);
}

/** Must run inside the store mutation lock, including the execution fence and stop. */
export async function applyThreadAbort(input: {
  state: StoredThreadState;
  thread: StoredThread;
  principal: RequestPrincipal;
  clientRequestId: string;
  scope?: CodingAbortScope;
}, deps: {
  provider?: CodingAgentProviderAdapter;
  abortInitial: () => void;
  abortTurn: () => void;
  terminalThread: (thread: StoredThread) => boolean;
  snapshotFor: (thread: StoredThread, events: AgentThreadEvent[]) => AgentThreadSnapshot;
  applyEvent: (thread: StoredThread, event: AgentThreadEvent) => StoredThread;
  clearActiveTurn: (thread: StoredThread) => StoredThread;
  settledTurn: (turn: StoredTurn, status: "aborted", at: string) => StoredTurn;
  turnStatusEvent: (threadId: string, turnId: string, status: "aborted") => AgentThreadEvent;
  stripOwner: (thread: StoredThread) => AgentThreadSummary;
  now: () => Date;
  nextEventId: () => string;
  maxAbortRequestIds: number;
}) {
  const { state, thread, principal, clientRequestId, scope } = input;
  const unchanged = () => ({ state, result: { snapshot: deps.snapshotFor(thread, state.events), eventsToPublish: [] as AgentThreadEvent[] } });
  if (scope && !matchesExecution(thread, state, scope)) return unchanged();
  if (!scope) deps.abortInitial();
  if (thread.abortClientRequestIds.includes(clientRequestId) || (deps.terminalThread(thread) && !thread.activeTurnId)) return unchanged();
  if (!scope) deps.abortTurn();

  const activeTurnId = thread.activeTurnId;
  let abortEvents: AgentThreadEvent[];
  try {
    if (!deps.provider?.abortThread) {
      if (scope) throw new Error("Confirmed execution stop unavailable");
      abortEvents = defaultAbortEvents(thread.id, deps.now, deps.nextEventId);
    } else {
      const abort = () => deps.provider!.abortThread!({
        principal, thread: deps.stripOwner(thread), clientRequestId, now: deps.now, nextEventId: deps.nextEventId,
        ...(scope ? { requireRuntimeStop: true } : {}),
      });
      const events = scope ? await boundedOperation(async () => abort(), 5_000) : await abort();
      abortEvents = parseCodingAgentProviderEvents(events, thread.id);
      const invalid = abortEvents.some((event) => event.type === "thread.completed" && event.outcome !== "aborted");
      const confirmed = abortEvents.some((event) => event.type === "thread.completed" && event.outcome === "aborted");
      if (scope && (!confirmed || invalid)) throw new Error("Execution stop was not confirmed");
      if (abortEvents.length === 0 || invalid) abortEvents = defaultAbortEvents(thread.id, deps.now, deps.nextEventId);
    }
  } catch (error) {
    logCodingAgentWarning("provider abort failed", error);
    // Never manufacture a terminal state for an unconfirmed automatic cleanup.
    // Keep local dispatch alive too: aborting it here can synthesize completion.
    if (scope) throw error;
    abortEvents = defaultAbortEvents(thread.id, deps.now, deps.nextEventId);
  }
  if (scope) { deps.abortInitial(); deps.abortTurn(); }
  let nextThread = thread;
  for (const event of abortEvents) nextThread = deps.applyEvent(nextThread, event);
  if (nextThread.status !== "aborted" || !abortEvents.some((event) => event.type === "thread.completed" && event.outcome === "aborted")) {
    const fallbackEvents = defaultAbortEvents(thread.id, deps.now, deps.nextEventId);
    abortEvents = [...abortEvents, ...fallbackEvents];
    for (const event of fallbackEvents) nextThread = deps.applyEvent(nextThread, event);
  }
  if (activeTurnId) abortEvents = [deps.turnStatusEvent(thread.id, activeTurnId, "aborted"), ...abortEvents];
  nextThread = { ...(activeTurnId || scope ? deps.clearActiveTurn(nextThread) : nextThread),
    abortClientRequestIds: [...nextThread.abortClientRequestIds, clientRequestId].slice(-deps.maxAbortRequestIds) };
  const nextState: StoredThreadState = { ...state,
    threads: state.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate),
    events: [...state.events, ...abortEvents],
    turns: activeTurnId ? state.turns.map((turn) => turn.ownerId === principal.userId && turn.threadId === thread.id && turn.turnId === activeTurnId
      ? deps.settledTurn(turn, "aborted", abortEvents.at(-1)!.occurredAt) : turn) : state.turns,
  };
  return { state: nextState, result: { snapshot: deps.snapshotFor(nextThread, nextState.events), eventsToPublish: abortEvents } };
}
