import { describe, expect, it } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { withPendingCanonicalTurn } from "../../packages/ui/src/canonical-chat-pending-turn";

// ENG-522: a sent message stayed invisible until the turn admission round trip
// returned (0.9 s on Matrix AI, 3.9-4.8 s on Claude). The pending turn shows it
// at once in the transcript both Web and Electron project from the detail.

const chatId = "chat_0123456789abcdef0123456789abcdef";
function detail(extra: Partial<CanonicalChatDetailResponse> = {}): CanonicalChatDetailResponse {
  return {
    record: { chat: { id: chatId, revision: 3 } },
    messages: [{ id: "msg_a", chatId, seq: 1, role: "user", state: "committed", parts: [{ type: "text", text: "earlier" }], createdAt: "2026-11-21T12:00:00.000Z" }],
    turns: [], runs: [], activities: [],
    ...extra,
  } as unknown as CanonicalChatDetailResponse;
}
const pending = { requestId: "req_pending1", chatId, parts: [{ type: "text" as const, text: "Reply with ok" }], createdAt: "2026-11-21T12:01:00.000Z" };

describe("pending canonical turn", () => {
  it("adds the sent message as the newest user turn", () => {
    const shown = withPendingCanonicalTurn(detail(), pending);
    const message = shown.messages.at(-1)!;
    expect(message).toMatchObject({ role: "user", seq: 2, parts: pending.parts });
    expect(shown.turns.at(-1)).toMatchObject({ clientRequestId: "req_pending1", inputMessageId: message.id, baseMessageSeq: 1, status: "accepted" });
    expect(detail().messages).toHaveLength(1);
  });

  it("disappears once the server's turn for the same request arrives", () => {
    const admitted = detail({ turns: [{ id: "cturn_real", chatId, clientRequestId: "req_pending1", baseMessageSeq: 1, inputMessageId: "msg_real", status: "accepted", createdAt: pending.createdAt, updatedAt: pending.createdAt }] as never });
    expect(withPendingCanonicalTurn(admitted, pending)).toBe(admitted);
  });

  it("never adds a pending turn to another chat or without one", () => {
    const other = detail({ record: { chat: { id: "chat_ffffffffffffffffffffffffffffffff", revision: 1 } } as never });
    expect(withPendingCanonicalTurn(other, pending)).toBe(other);
    const plain = detail();
    expect(withPendingCanonicalTurn(plain, null)).toBe(plain);
  });
});
