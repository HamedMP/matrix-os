import { createHash } from "node:crypto";
import type { AgentThreadEvent } from "@matrix-os/contracts";
import type { StoredThread, StoredTurn } from "./thread-store.js";

// Recognize only the historical first-record failure format. A different
// checkpoint or event format needs its own positive proof, never a guess based
// on failed status or a missing native conversation ID.
const INITIAL_FAILURE_BYTES = Buffer.byteLength('{"type":"turn.failed"}\n', "utf8");

function initialFailureEventId(sessionId: string, index: number): string {
  return `evt_codex_${createHash("sha256").update(`${sessionId}:0:${index}`).digest("hex").slice(0, 32)}`;
}

function failedRetryEnd(events: AgentThreadEvent[], start: number, turn: StoredTurn): number | undefined {
  const accepted = events[start], message = events[start + 1];
  if (accepted?.type !== "turn.accepted" || accepted.turnId !== turn.turnId
    || accepted.clientRequestId !== turn.clientRequestId || accepted.acceptedAt !== turn.acceptedAt
    || message?.type !== "user.message" || message.turnId !== turn.turnId
    || message.clientRequestId !== turn.clientRequestId) return undefined;
  let index = start + 2;
  const running = events[index];
  if (running?.type === "turn.status" && running.turnId === turn.turnId && running.status === "running") index++;
  const failed = events[index++], error = events[index++], completed = events[index++];
  if (failed?.type !== "turn.status" || failed.turnId !== turn.turnId || failed.status !== "failed"
    || error?.type !== "thread.error" || error.error.code !== "provider_run_failed"
    || completed?.type !== "thread.completed" || completed.outcome !== "failed") return undefined;
  return index;
}

/** Prove that no native turn ever started before allowing a new user retry. */
export function isFailedCodexBootstrap(input: {
  ownerId: string;
  thread: StoredThread;
  events: readonly AgentThreadEvent[];
  turns: readonly StoredTurn[];
}): boolean {
  const { thread, ownerId } = input;
  const resume = thread.providerResumeState;
  const sessionId = `sess_${thread.id.slice("thread_".length)}`;
  if (thread.ownerId !== ownerId || !thread.id.startsWith("thread_") || thread.providerId !== "codex" || thread.status !== "failed"
    || thread.activeTurnId || thread.deliveredTurnId || thread.terminalRef
    || !resume?.backgroundRef || resume.providerThreadId || resume.conversationId !== sessionId
    || thread.providerEventOffset !== INITIAL_FAILURE_BYTES) return false;

  const events = input.events.filter(event => event.threadId === thread.id);
  const turns = input.turns.filter(turn => turn.threadId === thread.id);
  if (turns.some(turn => turn.ownerId !== ownerId || turn.status !== "failed")) return false;
  const created = events[0], firstMessage = events[1];
  if (created?.type !== "thread.created" || created.thread.id !== thread.id || created.thread.providerId !== "codex"
    || firstMessage?.type !== "user.message" || firstMessage.turnId !== undefined
    || firstMessage.clientRequestId !== thread.clientRequestId) return false;

  let index = 2;
  while (events[index]?.type === "thread.status") {
    const event = events[index++];
    if (event?.type !== "thread.status" || !["queued", "starting", "running"].includes(event.status)) return false;
  }
  const error = events[index++], completed = events[index++];
  if (error?.type !== "thread.error" || error.error.code !== "provider_failed"
    || error.eventId !== initialFailureEventId(sessionId, 0)
    || completed?.type !== "thread.completed" || completed.outcome !== "failed"
    || completed.eventId !== initialFailureEventId(sessionId, 1)) return false;

  // A failed retry admitted by older code is recoverable only with its entire
  // non-delivery lifecycle retained. Missing/pruned records or any activity,
  // successful delivery, approval, or other unknown event fail closed.
  const seenTurnIds: string[] = [];
  while (index < events.length) {
    const accepted = events[index];
    if (accepted?.type !== "turn.accepted" || seenTurnIds.includes(accepted.turnId)) return false;
    const turn = turns.find(turn => turn.turnId === accepted.turnId);
    if (!turn) return false;
    const end = failedRetryEnd(events, index, turn);
    if (end === undefined) return false;
    seenTurnIds.push(turn.turnId);
    index = end;
  }
  return seenTurnIds.length === turns.length;
}
