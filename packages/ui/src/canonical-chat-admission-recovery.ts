import {
  CanonicalChatDetailResponseSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  canonicalChatTurnRequestIdentity,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCreateChatTurnRequest,
  type CanonicalChatDetailResponse,
} from "@matrix-os/contracts";

export type CanonicalChatClientAdmission = CanonicalChatTurnAdmissionResponse & {
  /** Local authenticated readback only; never part of the wire admission schema. */
  recoveredDetail?: CanonicalChatDetailResponse;
};

/** A lost acknowledgement is not proof of rejection. Ask the authenticated
 * admission lookup to attest to the saved original request hash, before Agent
 * or Bot execution overrides. Never repeat a potentially admitted write here.
 */
export async function recoverCanonicalChatAdmission(
  chatId: string,
  request: CanonicalCreateChatTurnRequest,
  readAdmission: (requestHash: string) => Promise<unknown>,
  readDetail?: () => Promise<unknown>,
): Promise<CanonicalChatClientAdmission | null> {
  let admission: CanonicalChatTurnAdmissionResponse;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(canonicalChatTurnRequestIdentity(request)));
    const requestHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    admission = CanonicalChatTurnAdmissionResponseSchema.parse(await readAdmission(requestHash));
    if (admission.record.chat.id !== chatId || admission.turn.clientRequestId !== request.clientRequestId
      || admission.admission !== "already_accepted" || admission.message.role !== "user"
      || admission.run.attempt !== 1 || JSON.stringify(admission.message.parts) !== JSON.stringify(request.parts)) return null;
  } catch (error: unknown) {
    console.warn("[canonical-chat] admission readback unavailable:", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
  if (readDetail) {
    try {
      const detail = CanonicalChatDetailResponseSchema.parse(await readDetail());
      if (detail.record.chat.id === chatId && detail.record.chat.revision >= admission.record.chat.revision
        && detail.turns.some(turn => turn.id === admission.turn.id)
        && detail.messages.some(message => message.id === admission.message.id)
        && detail.runs.some(run => run.id === admission.run.id)) return { ...admission, recoveredDetail: detail };
    } catch (error: unknown) {
      console.warn("[canonical-chat] recovered detail unavailable:", error instanceof Error ? error.name : "UnknownError");
    }
  }
  return admission;
}
