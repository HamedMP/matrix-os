import type { CanonicalChatMessagePart } from "@matrix-os/contracts";

/** The provider guarantees that this correction has not reached native execution. */
export class ChatSteerNotDeliveredError extends Error {
  constructor() { super("Steering was not delivered"); this.name = "ChatSteerNotDeliveredError"; }
}

/** Text-only delivery channels cannot consume a queued upload without its bytes. */
export function assertTextOnlySteering(parts: readonly CanonicalChatMessagePart[]): void {
  if (parts.some(part => part.type === "attachment_reference")) throw new ChatSteerNotDeliveredError();
}
