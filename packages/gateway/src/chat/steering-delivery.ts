import type { CanonicalChatSafeError } from "@matrix-os/contracts";
import { canonicalChatSafeError } from "./orchestration-errors.js";

/** Delivery may have succeeded. Neither adapters nor canonical queues may replay it. */
export class ChatSteerDeliveryUnknownError extends Error {
  constructor() { super("Steering delivery is unconfirmed"); this.name = "ChatSteerDeliveryUnknownError"; }
}

/** Authority and input validation must finish before entering this delivery boundary. */
export async function deliverAcknowledgedSteer(send: () => Promise<
  { ok: false; error: string } | { ok: true; reply: Record<string, unknown> }
>): Promise<boolean> {
  try {
    const result = await send();
    if (result.ok && typeof result.reply.acknowledged === "boolean") return result.reply.acknowledged;
    throw new ChatSteerDeliveryUnknownError();
  } catch (error: unknown) {
    if (error instanceof ChatSteerDeliveryUnknownError) throw error;
    // Socket failure, timeout or a rejected identity check cannot prove non-delivery.
    throw new ChatSteerDeliveryUnknownError();
  }
}

/** Preserve the durable pending fence when delivery is unknown; do not unlock queue drain. */
export async function settleSteerCallbackFailure(error: unknown, fail: () => Promise<void>, queued = false): Promise<CanonicalChatSafeError> {
  if (error instanceof ChatSteerDeliveryUnknownError) return canonicalChatSafeError("run_unavailable",
    queued ? "Steering delivery is unconfirmed. It will not be resent automatically. After the Run ends, remove the message from the queue if needed."
      : "Steering delivery is unconfirmed. It will not be resent automatically.");
  try { await fail(); }
  catch (finishError: unknown) {
    console.warn("[chat/orchestrator] Steering failure could not be persisted:", finishError instanceof Error ? finishError.name : "UnknownError");
  }
  return canonicalChatSafeError("run_unavailable", "The Run could not be steered. Try again.", true, ["retry"]);
}
