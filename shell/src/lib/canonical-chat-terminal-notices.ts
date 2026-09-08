import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import type { ChatMessage } from "./chat";
import { projectCanonicalMessages } from "./canonical-chat-client";

/** Keep terminal outcomes attached to their turn, using only safe fixed copy. */
export function projectCanonicalTranscript(detail: CanonicalChatDetailResponse): ChatMessage[] {
  const messages = projectCanonicalMessages(detail.messages);
  const inputs = detail.turns.map((turn) => ({
    turn,
    message: detail.messages.find((message) => message.id === turn.inputMessageId),
  })).filter((input) => input.message !== undefined)
    .sort((a, b) => a.message!.seq - b.message!.seq);
  // Insert backwards so earlier notices cannot change later insertion positions.
  for (let index = inputs.length - 1; index >= 0; index -= 1) {
    const { turn } = inputs[index];
    const run = detail.runs.filter((candidate) => candidate.turnId === turn.id)
      .reduce<(typeof detail.runs)[number] | undefined>((latest, candidate) =>
        !latest || candidate.attempt > latest.attempt ? candidate : latest, undefined);
    if (!run || (run.status !== "failed" && run.status !== "aborted")) continue;
    const nextInput = inputs[index + 1]?.turn.inputMessageId;
    const nextIndex = nextInput ? messages.findIndex((message) => message.id === nextInput) : -1;
    messages.splice(nextIndex < 0 ? messages.length : nextIndex, 0, {
      id: `${run.id}:terminal`, role: "system", requestId: run.id,
      content: run.status === "failed" ? "Agent work failed. Please try again." : "Agent work stopped.",
      timestamp: Date.parse(run.completedAt ?? run.updatedAt),
    });
  }
  return messages;
}
