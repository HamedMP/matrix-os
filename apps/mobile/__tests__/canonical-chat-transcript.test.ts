import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";

import {
  isOptimisticMessageDelivered,
  optimisticTranscriptMessage,
  type OptimisticUserMessage,
} from "../lib/canonical-chat-transcript";

// The contracts barrel pulls in ESM-only micromark, which Jest cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

function userMessage(id: string, seq: number, text: string) {
  return {
    id,
    chatId: "chat_1",
    role: "user",
    state: "committed",
    seq,
    parts: [{ type: "text", text }],
    createdAt: "2026-09-09T00:00:00.000Z",
  };
}

function turn(clientRequestId: string, inputMessageId: string) {
  return { id: `cturn_${inputMessageId}`, chatId: "chat_1", clientRequestId, inputMessageId };
}

function detailWith(
  messages: ReturnType<typeof userMessage>[],
  turns: ReturnType<typeof turn>[] = [],
  chatId = "chat_1",
) {
  return {
    record: { chat: { id: chatId } },
    runs: [],
    turns,
    activities: [],
    messages,
  } as unknown as CanonicalChatDetailResponse;
}

const optimistic: OptimisticUserMessage = {
  id: "optimistic-req_mine",
  chatId: "chat_1",
  text: "Ship it",
  turnRequestId: "req_mine",
  createdAt: 1_700_000_000_000,
};

describe("optimistic user messages", () => {
  it("renders as an ordinary sent user message", () => {
    expect(optimisticTranscriptMessage(optimistic)).toEqual({
      id: "optimistic-req_mine",
      role: "user",
      text: "Ship it",
      toolCalls: [],
      activities: [],
      isRunning: false,
      createdAt: 1_700_000_000_000,
    });
  });

  it("is delivered once the detail holds the message of the turn admitted for this send", () => {
    expect(isOptimisticMessageDelivered(null, optimistic)).toBe(false);
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_1", 1, "Hello")]), optimistic)).toBe(false);
    expect(isOptimisticMessageDelivered(
      detailWith([userMessage("msg_3", 3, "Ship it")], [turn("req_mine", "msg_3")]),
      optimistic,
    )).toBe(true);
  });

  it("is not delivered by the same text sent by another client or participant", () => {
    const detail = detailWith([userMessage("msg_3", 3, "Ship it")], [turn("req_theirs", "msg_3")]);
    expect(isOptimisticMessageDelivered(detail, optimistic)).toBe(false);
  });

  it("waits for the turn's message, not just the turn", () => {
    const detail = detailWith([userMessage("msg_1", 1, "Hello")], [turn("req_mine", "msg_3")]);
    expect(isOptimisticMessageDelivered(detail, optimistic)).toBe(false);
  });

  it("falls back to the admitted message id when the turn is not in the detail", () => {
    const admitted = { ...optimistic, messageId: "msg_3" };
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_3", 3, "Ship it")]), admitted)).toBe(true);
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_4", 4, "Ship it")]), admitted)).toBe(false);
  });

  it("ignores another chat's detail", () => {
    const other = detailWith([userMessage("msg_3", 3, "Ship it")], [turn("req_mine", "msg_3")], "chat_other");
    expect(isOptimisticMessageDelivered(other, optimistic)).toBe(false);
  });
});
