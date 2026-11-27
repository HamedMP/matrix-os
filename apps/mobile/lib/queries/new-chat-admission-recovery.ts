import type { CanonicalChatDetailResponse, CanonicalChatTurnAdmissionResponse } from "@matrix-os/contracts";

import { fetchChatDetail } from "@/lib/requests";

export class NewChatDeliveryUnconfirmedError extends Error {
  constructor() {
    super("Could not confirm delivery. Retry to check again.");
    this.name = "NewChatDeliveryUnconfirmedError";
  }
}

/**
 * A dropped request can still be committing on the computer. Check immediately,
 * then four more times a second apart. Each read has a two-second deadline,
 * including any wake wait, to keep recovery within fourteen seconds.
 * Reads never resubmit the prompt; a later retry keeps its original request IDs.
 */
export async function recoverNewChatAdmission({ gatewayUrl, chatId, turnRequestId, getToken }: {
  gatewayUrl: string;
  chatId: string;
  turnRequestId: string;
  getToken: () => Promise<string | null>;
}): Promise<{ detail: CanonicalChatDetailResponse; admission: CanonicalChatTurnAdmissionResponse }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    try {
      const detail = await fetchChatDetail(getToken, gatewayUrl, chatId, { timeoutMs: 2_000 });
      const turn = detail.turns.find((candidate) => candidate.clientRequestId === turnRequestId);
      const message = detail.messages.find((candidate) => candidate.id === turn?.inputMessageId);
      const run = detail.runs.find((candidate) => candidate.turnId === turn?.id);
      if (detail.record.chat.id === chatId && turn && message && run) {
        return { detail, admission: { record: detail.record, message, turn, run, admission: "already_accepted" } };
      }
    } catch (error: unknown) {
      console.warn("[mobile] new chat admission check failed", error instanceof Error ? error.name : "unknown");
    }
  }
  throw new NewChatDeliveryUnconfirmedError();
}
