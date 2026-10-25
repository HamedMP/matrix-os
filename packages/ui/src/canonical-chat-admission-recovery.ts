import {
  CanonicalChatDetailResponseSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";

/** A lost HTTP acknowledgement is not proof of rejection. Read the exact
 * idempotency key once; never repeat a potentially admitted write here.
 */
export async function recoverCanonicalChatAdmission(
  chatId: string,
  request: CanonicalCreateChatTurnRequest,
  read: () => Promise<unknown>,
): Promise<CanonicalChatTurnAdmissionResponse | null> {
  try {
    const detail = CanonicalChatDetailResponseSchema.parse(await read());
    if (detail.record.chat.id !== chatId) return null;
    const turn = detail.turns.find((candidate) => candidate.clientRequestId === request.clientRequestId);
    if (!turn) return null;
    const message = detail.messages.find((candidate) => candidate.id === turn.inputMessageId);
    const run = detail.runs.filter((candidate) => candidate.turnId === turn.id)
      .sort((a, b) => a.attempt - b.attempt)[0];
    if (!message || message.role !== "user" || !run || run.attempt !== 1
      || JSON.stringify(message.parts) !== JSON.stringify(request.parts)
      || JSON.stringify(run.selection) !== JSON.stringify(request.selection)
      || run.interactionMode !== request.interactionMode || run.permissionMode !== request.permissionMode
      || request.executionRoot && JSON.stringify(run.executionRoot) !== JSON.stringify(request.executionRoot)) return null;
    const parsed = CanonicalChatTurnAdmissionResponseSchema.safeParse({
      record: detail.record, message, turn, run, admission: "already_accepted",
    });
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    console.warn("[canonical-chat] admission readback unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}
